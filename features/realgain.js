// Ramnesia feature: realgain (background). See RN hooks in background.js.
//
// Measures the *real* system RAM freed by a batch of discards: free system memory
// (chrome.system.memory availableCapacity) is read right before the batch and sampled
// again a few seconds after it, once the discarded renderer processes have exited.
// The biggest increase over the "before" value ≈ RAM actually given back to the OS.
//
// Storage:
//   chrome.storage.local   realTotals = { bytes, batches, since }  (reliable measurements only)
//   chrome.storage.session realLast   = { at, bytes, count, estimateBytes, source }
(() => {
  const SAMPLE_AT_MS = [1500, 3000, 5000];        // after the batch; total wait < 8 s
  const MERGE_WINDOW_MS = 12000;                  // a batch starting this soon joins the running measurement
  const STALL_MS = 8000;                          // give up on a paused measurement after this
  const PLAUSIBLE_EXTRA = 2 * 1024 * 1024 * 1024; // 2 GB slack on top of 8 × estimate
  const PLAUSIBLE_FACTOR = 8;

  // Batches between their beforeBatch and afterBatch (normally at most one).
  const pending = [];
  // The measurement currently sampling (at most one).
  let active = null;
  // Serialises storage read-modify-writes.
  let writeChain = Promise.resolve();
  const queueWrite = (fn) =>
    (writeChain = writeChain.then(fn).catch((e) => console.warn("Ramnesia realgain store error", e)));

  async function availNow() {
    try {
      const m = await chrome.system.memory.getInfo();
      return Number.isFinite(m?.availableCapacity) ? m.availableCapacity : null;
    } catch {
      return null;
    }
  }

  async function getRealTotals() {
    const { realTotals } = await chrome.storage.local.get("realTotals");
    return realTotals || { bytes: 0, batches: 0, since: Date.now() };
  }

  const clearTimers = (m) => {
    m.timers.forEach(clearTimeout);
    m.timers = [];
  };

  function observe(m, avail) {
    if (avail != null) m.maxDelta = Math.max(m.maxDelta, avail - m.before);
  }

  // Ends a measurement (idempotent). `avail` = an optional last reading to include.
  function finish(m, avail) {
    if (m.done) return;
    m.done = true;
    clearTimers(m);
    observe(m, avail);
    if (active === m) active = null;

    const delta = Math.max(0, m.maxDelta); // OS reuse / other apps can make it negative
    const ceiling = PLAUSIBLE_FACTOR * m.estimateBytes + PLAUSIBLE_EXTRA;
    if (m.overlap || delta <= 0 || delta > ceiling) {
      console.debug("Ramnesia realgain: unreliable measurement skipped", {
        delta, estimate: m.estimateBytes, count: m.count, overlap: m.overlap
      });
      return;
    }
    const realLast = {
      at: Date.now(),
      bytes: delta,
      count: m.count,
      estimateBytes: m.estimateBytes,
      source: m.sources.size === 1 ? [...m.sources][0] : "mixed"
    };
    queueWrite(async () => {
      const realTotals = await getRealTotals();
      realTotals.bytes += delta;
      realTotals.batches += 1;
      await chrome.storage.local.set({ realTotals });
      await sset({ realLast });
    });
  }

  // Samples at 1.5 s / 3 s / 5 s; not awaited by anyone, so callers are never delayed.
  // The service worker stays alive well past the last sample (< 8 s, MV3 idle limit is 30 s).
  function schedule(m) {
    clearTimers(m);
    SAMPLE_AT_MS.forEach((ms, idx) => {
      m.timers.push(
        setTimeout(async () => {
          const avail = await availNow();
          if (m.done || m.holds > 0) return;
          observe(m, avail);
          if (idx === SAMPLE_AT_MS.length - 1) finish(m);
        }, ms)
      );
    });
  }

  RN.beforeBatch.push(async ({ tabIds, source }) => {
    // Interleaved batches (B starts before A's discards finished): their freed memory
    // can't be told apart, so every batch involved is marked as not measurable.
    const overlap = pending.length > 0;
    pending.forEach((p) => {
      p.overlap = true;
      if (p.merge) p.merge.overlap = true;
    });
    const entry = { tabIds: new Set(tabIds), source, before: null, overlap, merge: null };
    pending.push(entry);

    const m = active;
    if (m && !m.done && Date.now() - m.startedAt < MERGE_WINDOW_MS) {
      // The previous batch is still sampling and its renderers may still be exiting.
      // Taking a fresh baseline now would credit that tail to this batch, so this batch
      // joins the running measurement (same "before" value) and sampling restarts after it.
      entry.merge = m;
      m.holds++;
      clearTimers(m);
      m.timers.push(setTimeout(() => finish(m), STALL_MS)); // in case afterBatch never comes
      return;
    }
    const avail = await availNow();
    if (m) finish(m, avail); // older than the merge window: end it here
    entry.before = avail;
  });

  RN.afterBatch.push(async ({ tabIds, count, bytes, source }) => {
    // Matching before-entry: the latest one with this source containing these tabs.
    let i = -1;
    for (let k = pending.length - 1; k >= 0; k--) {
      const p = pending[k];
      if (p.source === source && tabIds.every((id) => p.tabIds.has(id))) {
        i = k;
        break;
      }
    }
    if (i < 0) return;
    const [entry] = pending.splice(i, 1);

    if (entry.merge) {
      const m = entry.merge;
      if (m.done) return; // stalled and already finished
      m.holds--;
      if (entry.overlap) m.overlap = true;
      if (count) {
        m.count += count;
        m.estimateBytes += bytes || 0;
        m.sources.add(source);
      }
      if (m.holds === 0) schedule(m);
      return;
    }

    if (!count || entry.before == null) return;
    if (active) finish(active); // safety; normally ended in beforeBatch
    const m = {
      before: entry.before,
      overlap: entry.overlap,
      count,
      estimateBytes: bytes || 0,
      sources: new Set([source]),
      startedAt: Date.now(),
      maxDelta: -Infinity,
      holds: 0,
      timers: [],
      done: false
    };
    active = m;
    schedule(m);
  });

  RN.statsExtras.push(async () => ({
    realLast: await sget("realLast", null),
    realTotals: await getRealTotals()
  }));

  RN.messages.realgainReset = async () => {
    await queueWrite(() =>
      chrome.storage.local.set({ realTotals: { bytes: 0, batches: 0, since: Date.now() } })
    );
    return { ok: true };
  };
})();

(() => {
  const SAMPLE_AT_MS = [1500, 3000, 5000];
  const MERGE_WINDOW_MS = 12000;
  const STALL_MS = 8000;
  const PLAUSIBLE_EXTRA = 2 * 1024 * 1024 * 1024;
  const PLAUSIBLE_FACTOR = 8;

  const pending = [];
  let active = null;
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

  function finish(m, avail) {
    if (m.done) return;
    m.done = true;
    clearTimers(m);
    observe(m, avail);
    if (active === m) active = null;

    const delta = Math.max(0, m.maxDelta);
    const ceiling = PLAUSIBLE_FACTOR * (m.estimateBytes + m.unmeasured * FALLBACK_BYTES) + PLAUSIBLE_EXTRA;
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
      heapBytes: m.estimateBytes,
      estimateBytes: m.estimateBytes,
      unmeasured: m.unmeasured,
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
    const overlap = pending.length > 0;
    pending.forEach((p) => {
      p.overlap = true;
      if (p.merge) p.merge.overlap = true;
    });
    const entry = { tabIds: new Set(tabIds), source, before: null, overlap, merge: null };
    pending.push(entry);

    const m = active;
    if (m && !m.done && Date.now() - m.startedAt < MERGE_WINDOW_MS) {
      entry.merge = m;
      m.holds++;
      clearTimers(m);
      m.timers.push(setTimeout(() => finish(m), STALL_MS));
      return;
    }
    const avail = await availNow();
    if (m) finish(m, avail);
    entry.before = avail;
  });

  RN.afterBatch.push(async ({ tabIds, count, heapBytes, unmeasured, source }) => {
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
      if (m.done) return;
      m.holds--;
      if (entry.overlap) m.overlap = true;
      if (count) {
        m.count += count;
        m.estimateBytes += heapBytes || 0;
        m.unmeasured += unmeasured || 0;
        m.sources.add(source);
      }
      if (m.holds === 0) schedule(m);
      return;
    }

    if (!count || entry.before == null) return;
    if (active) finish(active);
    const m = {
      before: entry.before,
      overlap: entry.overlap,
      count,
      estimateBytes: heapBytes || 0,
      unmeasured: unmeasured || 0,
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

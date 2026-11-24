async function tabMemory(tab, { cachedOnly = false } = {}) {
  const heap = await measureTab(tab.id, {
    maxAgeMs: tab.active ? MEM_TTL_ACTIVE_MS : MEM_TTL_BG_MS,
    cachedOnly: cachedOnly || !!tab.frozen
  });
  const providers = [...RN.memoryProviders].sort((a, b) => a.priority - b.priority);
  for (const p of providers) {
    try {
      const r = await p.fn(tab, heap);
      if (r && r.bytes > 0) return { bytes: r.bytes, kind: r.kind || "calibrated", heap };
    } catch (e) {
      console.warn("Ramnesia memory provider error", e);
    }
  }
  return heap ? { bytes: heap, kind: "heap", heap } : null;
}

let memCacheP = null;
const getMemCache = () => (memCacheP ??= sget("memCache", {}));

let memPersistTimer = null;
function persistMemCache() {
  if (memPersistTimer) return;
  memPersistTimer = setTimeout(async () => {
    memPersistTimer = null;
    try {
      await sset({ memCache: await getMemCache() });
    } catch {}
  }, MEM_PERSIST_DELAY_MS);
}

let measuring = 0;
const measureWaiters = [];
async function acquireMeasureSlot() {
  while (measuring >= MEASURE_CONCURRENCY) await new Promise((r) => measureWaiters.push(r));
  measuring++;
}
function releaseMeasureSlot() {
  measuring--;
  measureWaiters.shift()?.();
}

const measureInflight = new Map();
const measureFailedAt = new Map();

async function measureTab(tabId, { maxAgeMs = MEM_TTL_BG_MS, cachedOnly = false } = {}) {
  const cache = await getMemCache();
  const c = cache[tabId];
  if (c && (cachedOnly || Date.now() - c.t < maxAgeMs)) return c.bytes;
  if (cachedOnly) return null;
  if (measureInflight.has(tabId)) return measureInflight.get(tabId);
  const failed = measureFailedAt.get(tabId);
  if (!c && failed && Date.now() - failed < maxAgeMs) return null;

  const p = (async () => {
    await acquireMeasureSlot();
    try {
      const run = chrome.scripting.executeScript({
        target: { tabId },
        injectImmediately: true,
        func: () => (performance.memory ? performance.memory.usedJSHeapSize : null)
      });
      run.catch(() => null);
      const timeout = new Promise((r) => setTimeout(() => r(null), MEASURE_TIMEOUT_MS));
      const res = await Promise.race([run, timeout]);
      const bytes = res?.[0]?.result ?? null;
      if (bytes) {
        cache[tabId] = { bytes, t: Date.now() };
        measureFailedAt.delete(tabId);
        persistMemCache();
      } else {
        measureFailedAt.set(tabId, Date.now());
      }
      return bytes ?? c?.bytes ?? null;
    } catch {
      return c?.bytes ?? null;
    } finally {
      releaseMeasureSlot();
      measureInflight.delete(tabId);
    }
  })();
  measureInflight.set(tabId, p);
  return p;
}

async function memUsedPct() {
  try {
    const m = await chrome.system.memory.getInfo();
    if (!m?.capacity) return null;
    return ((m.capacity - m.availableCapacity) / m.capacity) * 100;
  } catch {
    return null;
  }
}

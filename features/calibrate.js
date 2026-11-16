(() => {
  const KEY = "calibration";
  const MIN_HEAP = 20 * 1024 * 1024;
  const RATIO_MIN = 0.5;
  const RATIO_MAX = 15;
  const FACTOR_MIN = 1;
  const FACTOR_MAX = 10;
  const WINDOW = 20;
  const READY_AT = 3;

  const empty = () => ({ factor: 1, samples: 0, updatedAt: null, ratios: [], lastAt: 0 });
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const isReady = (c) => c.samples >= READY_AT;

  function normalize(c) {
    if (!c || typeof c !== "object") return empty();
    const ratios = Array.isArray(c.ratios)
      ? c.ratios.filter((r) => Number.isFinite(r) && r >= RATIO_MIN && r <= RATIO_MAX).slice(-WINDOW)
      : [];
    return {
      factor: clamp(Number.isFinite(c.factor) ? c.factor : 1, FACTOR_MIN, FACTOR_MAX),
      samples: Number.isFinite(c.samples) ? Math.max(0, c.samples) : 0,
      updatedAt: c.updatedAt ?? null,
      ratios,
      lastAt: Number.isFinite(c.lastAt) ? c.lastAt : 0
    };
  }

  function medianFactor(ratios) {
    const logs = ratios.map(Math.log).sort((a, b) => a - b);
    const n = logs.length;
    if (!n) return 1;
    const mid = n >> 1;
    const ln = n % 2 ? logs[mid] : (logs[mid - 1] + logs[mid]) / 2;
    return clamp(Math.exp(ln), FACTOR_MIN, FACTOR_MAX);
  }

  let cache = null;
  let loading = null;
  async function load() {
    if (cache) return cache;
    if (!loading) {
      loading = chrome.storage.local
        .get(KEY)
        .then((r) => (cache = normalize(r[KEY])))
        .catch(() => (cache = empty()))
        .finally(() => (loading = null));
    }
    return loading;
  }

  let chain = Promise.resolve();
  const queue = (fn) =>
    (chain = chain.then(fn).catch((e) => console.warn("Ramnesia calibrate store error", e)));

  function addSample(m) {
    return queue(async () => {
      const real = Number(m?.bytes);
      const heap = Number(m?.heapBytes);
      const at = Number(m?.at) || 0;
      const c = normalize((await chrome.storage.local.get(KEY))[KEY]);
      if (at && at <= c.lastAt) return;
      if (Number(m?.unmeasured) > 0) return;
      if (!(heap >= MIN_HEAP) || !(real > 0)) return;
      const r = real / heap;
      if (!(r >= RATIO_MIN && r <= RATIO_MAX)) {
        console.debug("Ramnesia calibrate: ratio out of range, ignored", { real, heap, r });
        return;
      }
      c.ratios = [...c.ratios, r].slice(-WINDOW);
      c.samples += 1;
      c.factor = medianFactor(c.ratios);
      c.updatedAt = Date.now();
      if (at) c.lastAt = at;
      cache = c;
      await chrome.storage.local.set({ [KEY]: c });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.realLast?.newValue) addSample(changes.realLast.newValue);
    if (area === "local" && KEY in changes) cache = normalize(changes[KEY].newValue);
  });

  RN.memoryProviders.push({
    priority: 50,
    fn: async (_tab, heap) => {
      const c = await load();
      return isReady(c) && heap ? { bytes: Math.round(heap * c.factor), kind: "calibrated" } : null;
    }
  });

  RN.statsExtras.push(async () => {
    const c = await load();
    return { calibration: { factor: c.factor, samples: c.samples, ready: isReady(c), needed: READY_AT } };
  });

  RN.messages.calibrationReset = async () => {
    await queue(async () => {
      const prev = normalize((await chrome.storage.local.get(KEY))[KEY]);
      cache = { ...empty(), lastAt: prev.lastAt };
      await chrome.storage.local.set({ [KEY]: cache });
    });
    return { ok: true };
  };

  load();
})();

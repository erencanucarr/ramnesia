const DEFAULTS = {
  enabled: true,
  minutes: 5,
  skipPinned: true,
  skipAudible: true,
  notify: false,
  whitelist: [],
  siteRules: [],
  pressureMode: false,
  pressureThreshold: 85,
  pressureMinutes: 1
};

const RN = {
  skipHooks: [],
  beforeBatch: [],
  afterBatch: [],
  statsExtras: [],
  tabExtras: [],
  messages: {},
  memoryProviders: []
};

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

async function runHooks(list, ...args) {
  for (const h of list) {
    try {
      await h(...args);
    } catch (e) {
      console.warn("Ramnesia hook error", e);
    }
  }
}

async function extraSkipReason(tab, s) {
  for (const h of RN.skipHooks) {
    try {
      const r = await h(tab, s);
      if (r) return r;
    } catch (e) {
      console.warn("Ramnesia skip hook error", e);
    }
  }
  return null;
}

const ALARM = "ramnesia-tick";
const CHECK_EVERY_MIN = 0.5;
const FALLBACK_BYTES = 50 * 1024 * 1024;
const MEM_TTL_ACTIVE_MS = 15 * 1000;
const MEM_TTL_BG_MS = 2 * 60 * 1000;
const MEASURE_CONCURRENCY = 6;
const MEASURE_TIMEOUT_MS = 800;
const MEM_PERSIST_DELAY_MS = 2000;
const TABSINFO_BUDGET_MS = 300;

const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

async function getSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  s.pressureThreshold = clampInt(s.pressureThreshold, 50, 95, DEFAULTS.pressureThreshold);
  s.pressureMinutes = clampInt(s.pressureMinutes, 1, 60, DEFAULTS.pressureMinutes);
  return s;
}

const i18n = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;
const DECIMAL_SEP = /^tr\b/i.test(chrome.i18n.getUILanguage()) ? "," : ".";
async function sget(key, def) {
  const r = await chrome.storage.session.get(key);
  return r[key] ?? def;
}
const sset = (obj) => chrome.storage.session.set(obj);

async function getTotals() {
  const { totals } = await chrome.storage.local.get("totals");
  return totals || { bytes: 0, count: 0, since: Date.now() };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isWhitelisted(url, whitelist) {
  const host = hostOf(url);
  if (!host) return false;
  return whitelist.some((d) => {
    d = d.trim().toLowerCase().replace(/^www\./, "");
    return d && (host === d || host.endsWith("." + d));
  });
}

const isWeb = (url) => !!url && /^https?:/.test(url);

function skipReason(tab, s) {
  if (s.skipPinned && tab.pinned) return "pinned";
  if (tab.autoDiscardable === false) return "locked";
  if (tab.active) return "active";
  if (s.skipAudible && tab.audible) return "audible";
  if (isWhitelisted(tab.url, s.whitelist)) return "whitelist";
  return null;
}

function canDiscard(tab, s) {
  if (tab.discarded || tab.frozen || tab.status === "loading") return false;
  if (!isWeb(tab.url)) return false;
  return skipReason(tab, s) === null;
}

function fmtBytes(b) {
  const mb = b / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(1).replace(".", DECIMAL_SEP) + " GB";
  return Math.round(mb) + " MB";
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

async function effectiveLimit(s) {
  const usedPct = s.pressureMode ? await memUsedPct() : null;
  const pressureActive = !!s.pressureMode && usedPct != null && usedPct >= s.pressureThreshold;
  const minutes = pressureActive ? Math.min(s.minutes, s.pressureMinutes) : s.minutes;
  return { pressureActive, minutes, limitMs: minutes * 60 * 1000 };
}

function siteRuleFor(url, rules) {
  const host = hostOf(url);
  if (!host || !Array.isArray(rules)) return null;
  let best = null;
  for (const r of rules) {
    const d = String(r?.host || "").trim().toLowerCase().replace(/^www\./, "");
    const m = parseInt(r?.minutes, 10);
    if (!d || !(m >= 1)) continue;
    if ((host === d || host.endsWith("." + d)) && (!best || d.length > best.host.length)) {
      best = { host: d, minutes: Math.min(m, 1440) };
    }
  }
  return best;
}

function limitMsForTab(tab, s, eff) {
  const rule = siteRuleFor(tab.url, s.siteRules);
  if (!rule) return eff.limitMs;
  const minutes = eff.pressureActive ? Math.min(rule.minutes, s.pressureMinutes) : rule.minutes;
  return minutes * 60 * 1000;
}

const discardingIds = new Set();

async function discardTab(tab) {
  const m = await tabMemory(tab);
  const bytes = m?.bytes ?? FALLBACK_BYTES;
  const heap = m?.heap ?? null;
  let res;
  discardingIds.add(tab.id);
  try {
    try {
      res = await chrome.tabs.discard(tab.id);
    } catch {
      return null;
    }
    if (!res) return null;
    discardingIds.add(res.id);
    const saved = await sget("saved", {});
    saved[res.id] = { bytes, heap, kind: m?.kind || "fallback", estimated: m == null || m.kind !== "exact" };
    const totals = await getTotals();
    totals.bytes += bytes;
    totals.count += 1;
    await sset({ saved });
    await chrome.storage.local.set({ totals });
    return { bytes, heap };
  } finally {
    discardingIds.delete(tab.id);
    if (res) discardingIds.delete(res.id);
  }
}

async function discardBatch(tabs, source) {
  if (!tabs.length) return { count: 0, bytes: 0, heapBytes: 0, unmeasured: 0, tabIds: [] };
  await runHooks(RN.beforeBatch, { tabIds: tabs.map((t) => t.id), source });
  let count = 0;
  let bytes = 0;
  let heapBytes = 0;
  let unmeasured = 0;
  const tabIds = [];
  for (const tab of tabs) {
    const r = await discardTab(tab);
    if (r != null) {
      count++;
      bytes += r.bytes;
      if (r.heap == null) unmeasured++;
      else heapBytes += r.heap;
      tabIds.push(tab.id);
    }
  }
  await runHooks(RN.afterBatch, { tabIds, count, bytes, heapBytes, unmeasured, source });
  return { count, bytes, heapBytes, unmeasured, tabIds };
}

async function sweep({ force = false, filter = null, source = force ? "all" : "auto" } = {}) {
  const s = await getSettings();
  if (!s.enabled && !force) return { count: 0, bytes: 0 };

  const tabs = await chrome.tabs.query({});
  const seen = await sget("seen", {});
  const now = Date.now();
  const eff = await effectiveLimit(s);
  const candidates = [];

  for (const tab of tabs) {
    if (tab.active) {
      seen[tab.id] = now;
      continue;
    }
    if (seen[tab.id] == null) seen[tab.id] = tab.lastAccessed || now;
    const last = Math.max(seen[tab.id], tab.lastAccessed || 0);
    if ((force || now - last >= limitMsForTab(tab, s, eff)) && canDiscard(tab, s) && (!filter || filter(tab))) {
      if (!(await extraSkipReason(tab, s))) candidates.push(tab);
    }
  }

  const { count, bytes } = await discardBatch(candidates, source);

  const after = await chrome.tabs.query({});
  const alive = new Set(after.map((t) => String(t.id)));
  const sleeping = new Set(after.filter((t) => t.discarded).map((t) => String(t.id)));
  for (const id of Object.keys(seen)) if (!alive.has(id)) delete seen[id];
  const saved = await sget("saved", {});
  for (const id of Object.keys(saved)) if (!sleeping.has(id)) delete saved[id];
  await sset({ seen, saved });

  if (count > 0 && s.notify) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: i18n("extName"),
      message: i18n("notifyDiscarded", count, fmtBytes(bytes)),
      silent: true
    });
  }
  await updateBadge();
  return { count, bytes };
}

async function updateBadge() {
  const saved = await sget("saved", {});
  const total = Object.values(saved).reduce((a, x) => a + x.bytes, 0);
  let text = "";
  if (total > 0) {
    const mb = total / (1024 * 1024);
    text = mb >= 1024 ? (mb / 1024).toFixed(1) + "G" : Math.round(mb) + "M";
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#ffffff" });
}

function ensureAlarm() {
  chrome.alarms.get(ALARM, (a) => {
    if (!a) chrome.alarms.create(ALARM, { periodInMinutes: CHECK_EVERY_MIN });
  });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  updateBadge();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) sweep();
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const now = Date.now();
  const seen = await sget("seen", {});
  const activeByWindow = await sget("activeByWindow", {});
  const prev = activeByWindow[windowId];
  if (prev != null && prev !== tabId) seen[prev] = now;
  seen[tabId] = now;
  activeByWindow[windowId] = tabId;
  await sset({ seen, activeByWindow });
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.discarded === false) {
    const saved = await sget("saved", {});
    if (saved[tabId]) {
      delete saved[tabId];
      await sset({ saved });
      updateBadge();
    }
  } else if (info.discarded === true && !discardingIds.has(tabId)) {
    const saved = await sget("saved", {});
    if (!saved[tabId]) {
      const cache = await getMemCache();
      if (cache[tabId]) {
        saved[tabId] = { bytes: cache[tabId].bytes, heap: cache[tabId].bytes, kind: "heap", estimated: true, byChrome: true };
        await sset({ saved });
        updateBadge();
      }
    }
  }
  if (tab.active && info.status === "complete") {
    const seen = await sget("seen", {});
    seen[tabId] = Date.now();
    await sset({ seen });
  }
});

chrome.tabs.onReplaced.addListener(async (added, removed) => {
  const seen = await sget("seen", {});
  const saved = await sget("saved", {});
  if (seen[removed] != null) seen[added] = seen[removed];
  if (saved[removed]) saved[added] = saved[removed];
  delete seen[removed];
  delete saved[removed];
  await sset({ seen, saved });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const seen = await sget("seen", {});
  const saved = await sget("saved", {});
  const memCache = await getMemCache();
  delete seen[tabId];
  delete saved[tabId];
  delete memCache[tabId];
  measureFailedAt.delete(tabId);
  await sset({ seen, saved, memCache });
  updateBadge();
});

async function tabsInfo() {
  const s = await getSettings();
  const seen = await sget("seen", {});
  const saved = await sget("saved", {});
  const tabs = (await chrome.tabs.query({})).filter((t) => isWeb(t.url));
  const now = Date.now();
  const eff = await effectiveLimit(s);

  const budget = new Promise((r) => setTimeout(r, TABSINFO_BUDGET_MS));

  return Promise.all(
    tabs.map(async (t) => {
      const last = Math.max(seen[t.id] || 0, t.lastAccessed || 0) || now;
      const m = t.discarded
        ? null
        : await Promise.race([tabMemory(t), budget.then(() => tabMemory(t, { cachedOnly: true }))]);
      const extras = {};
      for (const h of RN.tabExtras) {
        try { Object.assign(extras, await h(t)); } catch (e) { console.warn(e); }
      }
      return {
        ...extras,
        id: t.id,
        windowId: t.windowId,
        title: t.title || t.url,
        host: hostOf(t.url),
        favIconUrl: t.favIconUrl || "",
        active: t.active,
        discarded: !!t.discarded,
        locked: t.autoDiscardable === false && !(s.skipPinned && t.pinned),
        pinProtected: !!(s.skipPinned && t.pinned),
        reason: skipReason(t, s) || (t.discarded ? null : await extraSkipReason(t, s)),
        memory: m?.bytes ?? null,
        memoryKind: m?.kind ?? null,
        heap: m?.heap ?? null,
        saved: saved[t.id] || null,
        remainingMs: Math.max(0, limitMsForTab(t, s, eff) - (now - last)),
        siteMinutes: siteRuleFor(t.url, s.siteRules)?.minutes ?? null
      };
    })
  );
}

async function stats() {
  const s = await getSettings();
  const eff = await effectiveLimit(s);
  const tabs = await chrome.tabs.query({});
  const saved = await sget("saved", {});
  const vals = Object.values(saved);
  let system = null;
  try {
    const m = await chrome.system.memory.getInfo();
    system = { capacity: m.capacity, available: m.availableCapacity };
  } catch {}
  const extras = {};
  for (const h of RN.statsExtras) {
    try { Object.assign(extras, await h()); } catch (e) { console.warn(e); }
  }
  return {
    ...extras,
    system,
    total: tabs.filter((t) => isWeb(t.url)).length,
    discarded: tabs.filter((t) => t.discarded).length,
    savedNow: vals.reduce((a, x) => a + x.bytes, 0),
    hasEstimate: vals.some((x) => x.estimated),
    pressureActive: s.enabled && eff.pressureActive,
    effectiveMinutes: eff.minutes,
    totals: await getTotals()
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (p) => {
    p.then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
    return true;
  };
  switch (msg?.type) {
    case "stats":
      return reply(stats());
    case "tabsInfo":
      return reply(tabsInfo());
    case "discardNow":
      return reply(sweep({ force: true }));
    case "discardOne":
      return reply(
        chrome.tabs.get(msg.tabId).then(async (t) => {
          const r = await discardBatch([t], "manual");
          await updateBadge();
          return { ok: r.count > 0, bytes: r.bytes };
        })
      );
    case "setLock":
      return reply(
        chrome.tabs.update(msg.tabId, { autoDiscardable: !msg.locked }).then(() => ({ ok: true }))
      );
    case "resetTotals":
      return reply(
        chrome.storage.local
          .set({
            totals: { bytes: 0, count: 0, since: Date.now() },
            realTotals: { bytes: 0, batches: 0, since: Date.now() }
          })
          .then(() => ({ ok: true }))
      );
    default:
      if (msg?.type && RN.messages[msg.type]) return reply(RN.messages[msg.type](msg, _sender));
  }
});

ensureAlarm();
updateBadge();

importScripts(
  "features/guard.js",
  "features/idle.js",
  "features/groups.js",
  "features/realgain.js",
  "features/calibrate.js",
  "features/processes.js",
  "features/menu.js",
  "features/pinned.js"
);

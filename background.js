// Ramnesia – belirli süre girilmeyen sekmeleri chrome.tabs.discard ile uyutur
// ve uyutulan sekmelerin ne kadar bellek boşalttığını takip eder.

const DEFAULTS = {
  enabled: true,
  minutes: 5,          // kaç dakika girilmeyince uyutulsun
  skipPinned: true,    // sabitlenmiş sekmelere dokunma
  skipAudible: true,   // ses çalan sekmelere dokunma
  notify: false,       // uyutunca masaüstü bildirimi göster
  whitelist: [],       // hiç uyutulmayacak alan adları (ör. "youtube.com")
  pressureMode: false, // RAM yüksekken boşta sekmeleri daha erken uyut
  pressureThreshold: 85, // % kullanılan RAM (50–95)
  pressureMinutes: 1   // RAM yüksekken uyutma süresi (1–60 dk)
};

// --- özellik takılma noktaları ---------------------------------------------
// features/*.js dosyaları bu dizilere fonksiyon ekler (en altta importScripts ile yüklenir).
// Her özellik kendi varsayılan ayarlarını Object.assign(DEFAULTS, {...}) ile ekler.
const RN = {
  skipHooks: [],    // async (tab, settings) => "reasonKey" | null   → sekmeyi otomatik uyutma
  beforeBatch: [],  // async ({ tabIds, source }) => void            → uyutmadan hemen önce
  afterBatch: [],   // async ({ tabIds, count, bytes, source }) => void → uyutmadan hemen sonra
  statsExtras: [],  // async () => object   → popup "stats" cevabına eklenir
  tabExtras: [],    // async (tab) => object → popup "tabsInfo" her sekme kaydına eklenir
  messages: {},     // { type: async (msg, sender) => result } → yeni mesaj türleri
  // Sekme belleği kaynakları: { priority, fn: async (tab, heapBytes) => { bytes, kind } | null }
  // Küçük priority önce denenir; ilk dolu sonuç kullanılır. kind: "exact" | "calibrated".
  // Hiçbiri sonuç vermezse ham JS belleği kullanılır (kind: "heap").
  memoryProviders: []
};

// Bir sekmenin bellek değeri: { bytes, kind, heap } | null
// heap: ham JS belleği (performance.memory) — kalibrasyon için hep ayrıca taşınır.
async function tabMemory(tab) {
  const heap = await measureTab(tab.id);
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
const CHECK_EVERY_MIN = 0.5;                 // 30 sn'de bir kontrol
const FALLBACK_BYTES = 50 * 1024 * 1024;     // ölçülemeyen sekme için tahmin
const MEM_CACHE_MS = 30 * 1000;

// --- depolama yardımcıları -------------------------------------------------
// session: tarayıcı kapanınca silinir (sekme kimlikleri zaten değişir)
// local:   kalıcı toplam istatistikler

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

// --- yerelleştirme ---------------------------------------------------------

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
  if (tab.autoDiscardable === false) return "locked";
  if (tab.active) return "active";
  if (s.skipPinned && tab.pinned) return "pinned";
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

// --- bellek ölçümü ---------------------------------------------------------
// Sekmenin JS belleğini (performance.memory) okur. Bu, sekmenin toplam RAM'inin
// bir alt sınırıdır; gerçek kazanç genelde daha yüksektir.

// Önbellek bellekte tek bir nesnede tutulur; paralel ölçümler aynı nesneyi güncellediği
// için birbirinin kaydını silmez. Oturum deposuna da yazılır (worker yeniden başlarsa diye).
// Yükleme sözü (promise) saklanır: soğuk başlangıçta aynı anda gelen çağrılar da
// aynı nesneyi alır.
let memCacheP = null;
const getMemCache = () => (memCacheP ??= sget("memCache", {}));

async function measureTab(tabId) {
  const cache = await getMemCache();
  const c = cache[tabId];
  if (c && Date.now() - c.t < MEM_CACHE_MS) return c.bytes;
  try {
    const run = chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: () => (performance.memory ? performance.memory.usedJSHeapSize : null)
    });
    run.catch(() => null); // zaman aşımından sonra gelen hata "Uncaught (in promise)" olmasın
    const timeout = new Promise((r) => setTimeout(() => r(null), 800));
    const res = await Promise.race([run, timeout]);
    const bytes = res?.[0]?.result ?? null;
    if (bytes) {
      cache[tabId] = { bytes, t: Date.now() };
      await sset({ memCache: cache });
    }
    return bytes;
  } catch {
    return null;
  }
}

// --- RAM baskısı ----------------------------------------------------------
// Sistem RAM kullanımı eşiği aşınca (ve mod açıksa) daha kısa süre uygulanır.

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

// --- uyutma ----------------------------------------------------------------

// Şu an bu eklentinin uyutmakta olduğu sekmeler: onUpdated'deki "Chrome uyuttu" yolu
// bunlara dokunmamalı, yoksa buradaki kaydın üstüne yazabilir.
const discardingIds = new Set();

// Döner: { bytes, heap } | null. bytes = gösterilen kazanç, heap = ham JS belleği (ölçülemediyse null).
async function discardTab(tab) {
  const m = await tabMemory(tab);
  const bytes = m?.bytes ?? FALLBACK_BYTES;
  const heap = m?.heap ?? null; // null = ölçülemedi (50 MB tahmini sadece gösterim için)
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

// Bir grup sekmeyi uyutur; özelliklerin before/after kancalarını çalıştırır.
// source: "auto" | "manual" | "all" | özelliklerin kendi adları (ör. "idle", "group")
async function discardBatch(tabs, source) {
  if (!tabs.length) return { count: 0, bytes: 0, heapBytes: 0, unmeasured: 0, tabIds: [] };
  await runHooks(RN.beforeBatch, { tabIds: tabs.map((t) => t.id), source });
  let count = 0;
  let bytes = 0;     // gösterilen kazanç (exact/calibrated/heap karışık olabilir)
  let heapBytes = 0; // ölçülen sekmelerin ham JS belleği toplamı — kalibrasyon bununla yapılmalı
  let unmeasured = 0; // JS belleği ölçülemeyen (50 MB tahmin edilen) sekme sayısı
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

// force: süreyi beklemeden uyut. filter: ek sekme süzgeci (tab => bool). source: kancalar için etiket.
async function sweep({ force = false, filter = null, source = force ? "all" : "auto" } = {}) {
  const s = await getSettings();
  if (!s.enabled && !force) return { count: 0, bytes: 0 };

  const tabs = await chrome.tabs.query({});
  const seen = await sget("seen", {});
  const now = Date.now();
  const { limitMs: limit } = await effectiveLimit(s);
  const candidates = [];

  for (const tab of tabs) {
    if (tab.active) {
      seen[tab.id] = now;
      continue;
    }
    if (seen[tab.id] == null) seen[tab.id] = tab.lastAccessed || now;
    const last = Math.max(seen[tab.id], tab.lastAccessed || 0);
    if ((force || now - last >= limit) && canDiscard(tab, s) && (!filter || filter(tab))) {
      if (!(await extraSkipReason(tab, s))) candidates.push(tab);
    }
  }

  const { count, bytes } = await discardBatch(candidates, source);

  // Kapanmış sekmeleri temizle, uyanmış sekmelerin kazancını düş.
  // Sekmeler uyutmadan SONRA yeniden sorgulanır; yoksa az önce uyutulanların kaydı silinir.
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

// --- rozet (eklenti simgesindeki küçük yazı) --------------------------------

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

// --- olaylar ---------------------------------------------------------------

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
  if (prev != null && prev !== tabId) seen[prev] = now; // bırakılan sekmenin sayacı şimdi başlar
  seen[tabId] = now;
  activeByWindow[windowId] = tabId;
  await sset({ seen, activeByWindow });
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.discarded === false) {
    // sekme uyandı → artık o bellek kullanılıyor
    const saved = await sget("saved", {});
    if (saved[tabId]) {
      delete saved[tabId];
      await sset({ saved });
      updateBadge();
    }
  } else if (info.discarded === true && !discardingIds.has(tabId)) {
    // Chrome'un kendisi uyuttuysa ve önceden ölçmüşsek onu da göster
    // (bu eklentinin uyuttuğu sekmeler discardingIds'tedir; onları discardTab kaydeder)
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

// Bazı Chrome sürümlerinde uyutulan sekmenin kimliği değişebilir
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
  await sset({ seen, saved, memCache });
  updateBadge();
});

// --- popup mesajları -------------------------------------------------------

async function tabsInfo() {
  const s = await getSettings();
  const seen = await sget("seen", {});
  const saved = await sget("saved", {});
  const tabs = (await chrome.tabs.query({})).filter((t) => isWeb(t.url));
  const now = Date.now();
  const { limitMs: limit } = await effectiveLimit(s);

  return Promise.all(
    tabs.map(async (t) => {
      const last = Math.max(seen[t.id] || 0, t.lastAccessed || 0) || now;
      const m = t.discarded ? null : await tabMemory(t);
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
        locked: t.autoDiscardable === false,
        reason: skipReason(t, s) || (t.discarded ? null : await extraSkipReason(t, s)),
        memory: m?.bytes ?? null,        // gösterilecek değer
        memoryKind: m?.kind ?? null,     // "exact" | "calibrated" | "heap" | null
        heap: m?.heap ?? null,           // ham JS belleği
        saved: saved[t.id] || null,
        remainingMs: Math.max(0, limit - (now - last))
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
      // autoDiscardable:false hem bu eklentiyi hem Chrome'un kendi Bellek Tasarrufu'nu durdurur
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

// Özellik modülleri (aynı global kapsamı paylaşır; yukarıdaki fonksiyonları kullanabilir)
importScripts(
  "features/guard.js",
  "features/idle.js",
  "features/groups.js",
  "features/realgain.js",
  "features/calibrate.js",
  "features/processes.js"
);

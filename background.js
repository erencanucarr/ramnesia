// Ramnesia – belirli süre girilmeyen sekmeleri chrome.tabs.discard ile uyutur
// ve uyutulan sekmelerin ne kadar bellek boşalttığını takip eder.

const DEFAULTS = {
  enabled: true,
  minutes: 5,          // kaç dakika girilmeyince uyutulsun
  skipPinned: true,    // sabitlenmiş sekmelere dokunma
  skipAudible: true,   // ses çalan sekmelere dokunma
  notify: false,       // uyutunca masaüstü bildirimi göster
  whitelist: []        // hiç uyutulmayacak alan adları (ör. "youtube.com")
};

const ALARM = "ramnesia-tick";
const CHECK_EVERY_MIN = 0.5;                 // 30 sn'de bir kontrol
const FALLBACK_BYTES = 50 * 1024 * 1024;     // ölçülemeyen sekme için tahmin
const MEM_CACHE_MS = 30 * 1000;

// --- depolama yardımcıları -------------------------------------------------
// session: tarayıcı kapanınca silinir (sekme kimlikleri zaten değişir)
// local:   kalıcı toplam istatistikler

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}
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
  if (mb >= 1024) return (mb / 1024).toFixed(1).replace(".", ",") + " GB";
  return Math.round(mb) + " MB";
}

// --- bellek ölçümü ---------------------------------------------------------
// Sekmenin JS belleğini (performance.memory) okur. Bu, sekmenin toplam RAM'inin
// bir alt sınırıdır; gerçek kazanç genelde daha yüksektir.

async function measureTab(tabId) {
  const cache = await sget("memCache", {});
  const c = cache[tabId];
  if (c && Date.now() - c.t < MEM_CACHE_MS) return c.bytes;
  try {
    const run = chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: () => (performance.memory ? performance.memory.usedJSHeapSize : null)
    });
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

// --- uyutma ----------------------------------------------------------------

async function discardTab(tab) {
  const measured = await measureTab(tab.id);
  const bytes = measured ?? FALLBACK_BYTES;
  let res;
  try {
    res = await chrome.tabs.discard(tab.id);
  } catch {
    return null;
  }
  if (!res) return null;
  const saved = await sget("saved", {});
  saved[res.id] = { bytes, estimated: measured == null };
  const totals = await getTotals();
  totals.bytes += bytes;
  totals.count += 1;
  await sset({ saved });
  await chrome.storage.local.set({ totals });
  return bytes;
}

async function sweep({ force = false } = {}) {
  const s = await getSettings();
  if (!s.enabled && !force) return { count: 0, bytes: 0 };

  const tabs = await chrome.tabs.query({});
  const seen = await sget("seen", {});
  const now = Date.now();
  const limit = s.minutes * 60 * 1000;
  let count = 0;
  let bytes = 0;

  for (const tab of tabs) {
    if (tab.active) {
      seen[tab.id] = now;
      continue;
    }
    if (seen[tab.id] == null) seen[tab.id] = tab.lastAccessed || now;
    const last = Math.max(seen[tab.id], tab.lastAccessed || 0);
    if ((force || now - last >= limit) && canDiscard(tab, s)) {
      const b = await discardTab(tab);
      if (b != null) {
        count++;
        bytes += b;
      }
    }
  }

  // Kapanmış sekmeleri temizle, uyanmış sekmelerin kazancını düş
  const alive = new Set(tabs.map((t) => String(t.id)));
  const sleeping = new Set(tabs.filter((t) => t.discarded).map((t) => String(t.id)));
  for (const id of Object.keys(seen)) if (!alive.has(id)) delete seen[id];
  const saved = await sget("saved", {});
  for (const id of Object.keys(saved)) if (!sleeping.has(id)) delete saved[id];
  await sset({ seen, saved });

  if (count > 0 && s.notify) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Ramnesia",
      message: `${count} sekme uyutuldu · ~${fmtBytes(bytes)} bellek boşaltıldı`,
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
  } else if (info.discarded === true) {
    // Chrome'un kendisi uyuttuysa ve önceden ölçmüşsek onu da göster
    const saved = await sget("saved", {});
    if (!saved[tabId]) {
      const cache = await sget("memCache", {});
      if (cache[tabId]) {
        saved[tabId] = { bytes: cache[tabId].bytes, estimated: false, byChrome: true };
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
  const memCache = await sget("memCache", {});
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
  const limit = s.minutes * 60 * 1000;

  return Promise.all(
    tabs.map(async (t) => {
      const last = Math.max(seen[t.id] || 0, t.lastAccessed || 0) || now;
      const mem = t.discarded ? null : await measureTab(t.id);
      return {
        id: t.id,
        windowId: t.windowId,
        title: t.title || t.url,
        host: hostOf(t.url),
        favIconUrl: t.favIconUrl || "",
        active: t.active,
        discarded: !!t.discarded,
        locked: t.autoDiscardable === false,
        reason: skipReason(t, s),
        memory: mem,
        saved: saved[t.id] || null,
        remainingMs: Math.max(0, limit - (now - last))
      };
    })
  );
}

async function stats() {
  const tabs = await chrome.tabs.query({});
  const saved = await sget("saved", {});
  const vals = Object.values(saved);
  let system = null;
  try {
    const m = await chrome.system.memory.getInfo();
    system = { capacity: m.capacity, available: m.availableCapacity };
  } catch {}
  return {
    system,
    total: tabs.filter((t) => isWeb(t.url)).length,
    discarded: tabs.filter((t) => t.discarded).length,
    savedNow: vals.reduce((a, x) => a + x.bytes, 0),
    hasEstimate: vals.some((x) => x.estimated),
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
          const b = await discardTab(t);
          await updateBadge();
          return { ok: b != null, bytes: b };
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
          .set({ totals: { bytes: 0, count: 0, since: Date.now() } })
          .then(() => ({ ok: true }))
      );
  }
});

ensureAlarm();
updateBadge();

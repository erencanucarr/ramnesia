const DEFAULTS = {
  enabled: true,
  minutes: 5,
  skipPinned: true,
  skipAudible: true,
  notify: false,
  whitelist: [],
  pressureMode: false,
  pressureThreshold: 85,
  pressureMinutes: 1
};

// sayı alanları: [min, max, varsayılan]
const NUM_LIMITS = {
  minutes: [1, 240, DEFAULTS.minutes],
  pressureThreshold: [50, 95, DEFAULTS.pressureThreshold],
  pressureMinutes: [1, 60, DEFAULTS.pressureMinutes]
};

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

// --- özellik takılma noktaları ---------------------------------------------
// features/*.popup.js dosyaları popup.js'ten sonra yüklenir ve buraya fonksiyon ekler.
// Yer tutucular (popup.html): #heroExtra, #groupSection, #featureSettings
const RNP = {
  afterStats: [], // (statsResponse) => void   → her yenilemede
  afterTabs: [],  // (tabsArray) => void        → her yenilemede
  init: []        // () => void | Promise       → popup açılınca bir kez (ayarları yükle vb.)
};
function runPopupHooks(list, ...args) {
  for (const h of list) {
    try { h(...args); } catch (e) { console.warn("Ramnesia popup hook error", e); }
  }
}

// --- yerelleştirme ---------------------------------------------------------

const i18n = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;
const UI_LANG = chrome.i18n.getUILanguage();
const DECIMAL_SEP = /^tr\b/i.test(UI_LANG) ? "," : ".";

function localizePage() {
  document.documentElement.lang = UI_LANG;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = i18n(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = i18n(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = i18n(el.dataset.i18nTitle);
  });
}
localizePage();

function fmtBytes(b) {
  const mb = b / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(1).replace(".", DECIMAL_SEP) + " GB";
  return Math.round(mb) + " MB";
}

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

const ICONS = {
  lock: '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>'
};

// --- ayarlar ---------------------------------------------------------------

let current = { ...DEFAULTS };  // son kaydedilen ayarlar
let pressure = { active: false, minutes: null }; // arka plandan gelen RAM baskısı durumu

function readNum(id) {
  const [min, max, def] = NUM_LIMITS[id];
  let n = parseInt($(id).value, 10);
  if (!Number.isFinite(n)) n = def;
  n = Math.min(max, Math.max(min, n));
  $(id).value = n;
  return n;
}

async function loadSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  $("enabled").checked = s.enabled;
  $("minutes").value = s.minutes;
  $("skipPinned").checked = s.skipPinned;
  $("skipAudible").checked = s.skipAudible;
  $("notify").checked = s.notify;
  $("pressureMode").checked = s.pressureMode;
  $("pressureThreshold").value = s.pressureThreshold;
  $("pressureMinutes").value = s.pressureMinutes;
  $("whitelist").value = s.whitelist.join("\n");
  current = s;
  readNum("pressureThreshold");
  readNum("pressureMinutes");
  applyPressureOpts(s.pressureMode);
  renderMode();
}

function applyPressureOpts(on) {
  $("pressureOpts").hidden = !on;
  $("pressureOpts").querySelectorAll("input, button").forEach((el) => (el.disabled = !on));
}

function renderMode() {
  const active = current.enabled && current.pressureMode && pressure.active;
  let text;
  if (!current.enabled) text = i18n("modeOff");
  else if (active) text = i18n("modeOnPressure", pressure.minutes ?? Math.min(current.minutes, current.pressureMinutes));
  else text = i18n("modeOnMinutes", current.minutes);
  $("modeText").textContent = text;
  $("pressurePill").hidden = !active;
  $("pressurePill").title = active ? i18n("pressurePillTitle", current.pressureThreshold) : "";
}

function parseWhitelist() {
  return [...new Set(
    $("whitelist").value
      .split(/\s+/)
      .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, ""))
      .filter(Boolean)
  )];
}

async function save(quiet) {
  const s = {
    enabled: $("enabled").checked,
    minutes: readNum("minutes"),
    skipPinned: $("skipPinned").checked,
    skipAudible: $("skipAudible").checked,
    notify: $("notify").checked,
    pressureMode: $("pressureMode").checked,
    pressureThreshold: readNum("pressureThreshold"),
    pressureMinutes: readNum("pressureMinutes"),
    whitelist: parseWhitelist()
  };
  await chrome.storage.sync.set(s);
  current = { ...current, ...s };
  applyPressureOpts(s.pressureMode);
  renderMode();
  if (!quiet) toast(i18n("settingsSaved"));
  refresh();
}

// --- özet kartı ------------------------------------------------------------

let lastSavedNow = null;

async function renderStats() {
  const r = await send({ type: "stats" });
  if (!r || r.error) return;
  const el = $("savedNow");
  el.textContent = (r.hasEstimate ? "≈ " : "") + fmtBytes(r.savedNow);
  $("sleepCount").textContent = i18n("sleepingOfTotal", r.discarded, r.total);
  $("totalSaved").textContent = i18n("totalGain", fmtBytes(r.totals.bytes));
  $("totalSaved").title = i18n("totalGainTitle", r.totals.count);
  system = r.system;
  pressure = { active: !!r.pressureActive, minutes: r.effectiveMinutes ?? null };
  renderMode();
  renderSystem();

  if (lastSavedNow != null && r.savedNow > lastSavedNow) {
    toast(i18n("freedToast", fmtBytes(r.savedNow - lastSavedNow)));
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
  }
  lastSavedNow = r.savedNow;
  runPopupHooks(RNP.afterStats, r);
}

// --- sistem belleği + aktif sekmeler ----------------------------------------

let system = null;
let awakeBytes = 0;

function renderSystem() {
  if (!system) {
    $("sysUsed").textContent = i18n("unknown");
    return;
  }
  const used = system.capacity - system.available;
  const pct = Math.round((used / system.capacity) * 100);
  $("sysUsed").textContent = fmtBytes(used);
  $("sysCap").textContent = `/ ${fmtBytes(system.capacity)}`;
  $("sysPct").textContent = i18n("percentValue", pct);
  $("sysPct").classList.toggle("high", pct >= (current.pressureMode ? current.pressureThreshold : 85));
  $("sysFree").textContent = i18n("freeMemory", fmtBytes(system.available));
  const tabsPct = Math.min(pct, (awakeBytes / system.capacity) * 100);
  $("meterTabs").style.width = `${tabsPct}%`;
  $("meterOther").style.width = `${pct - tabsPct}%`;
}

function renderAwake() {
  const awake = tabs.filter((t) => !t.discarded);
  const measured = awake.filter((t) => t.memory);
  awakeBytes = measured.reduce((a, t) => a + t.memory, 0);
  $("awakeMem").textContent = measured.length ? fmtBytes(awakeBytes) : "–";
  $("awakeCount").textContent = i18n("awakeCount", awake.length);
  $("heroNote").textContent = i18n("heroNote");
  renderSystem();
}

// --- sekme listesi ---------------------------------------------------------

let tabs = [];

function statusParts(t) {
  if (t.discarded) {
    return t.saved
      ? [["good", i18n("statusSleeping")], ["", i18n("freedAmount", (t.saved.estimated ? "≈ " : "") + fmtBytes(t.saved.bytes))]]
      : [["good", i18n("statusSleeping")]];
  }
  const mem = t.memory ? [["", fmtBytes(t.memory)]] : [];
  const map = {
    locked: ["lock", i18n("reasonLocked")],
    active: ["", i18n("reasonActive")],
    pinned: ["", i18n("reasonPinned")],
    audible: ["", i18n("reasonAudible")],
    whitelist: ["", i18n("reasonWhitelist")]
  };
  // özelliklerin eklediği nedenler için çeviri anahtarı: "reason_<neden>" (ör. reason_typing)
  if (t.reason) return [map[t.reason] || ["lock", i18n("reason_" + t.reason)], ...mem];
  const min = Math.ceil(t.remainingMs / 60000);
  const when = t.remainingMs <= 60000 ? ["soon", i18n("sleepSoon")] : ["", i18n("sleepInMinutes", min)];
  return [when, ...mem];
}

function favicon(t) {
  if (t.favIconUrl && /^(https?|data):/.test(t.favIconUrl)) {
    const img = document.createElement("img");
    img.src = t.favIconUrl;
    img.onerror = () => img.replaceWith(Object.assign(document.createElement("span"), { className: "fav" }));
    return img;
  }
  return Object.assign(document.createElement("span"), { className: "fav" });
}

function renderTabs() {
  const q = $("search").value.trim().toLowerCase();
  const list = tabs.filter((t) => !q || t.title.toLowerCase().includes(q) || t.host.includes(q));
  const ul = $("tabList");
  ul.replaceChildren();

  if (!list.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = q ? i18n("noMatch") : i18n("noTabs");
    ul.append(li);
    return;
  }

  for (const t of list) {
    const li = document.createElement("li");
    if (t.discarded) li.classList.add("sleeping");

    const info = document.createElement("div");
    info.className = "info";
    info.title = `${t.title}\n${t.host}\n${i18n("clickToSwitch")}`;
    const title = Object.assign(document.createElement("div"), { className: "title", textContent: t.title });
    const status = document.createElement("div");
    status.className = "status";
    statusParts(t).forEach(([cls, text], i) => {
      const span = document.createElement("span");
      if (i === 0 && cls !== undefined) span.className = "pill " + cls;
      span.textContent = text;
      status.append(span);
    });
    info.append(title, status);
    info.addEventListener("click", async () => {
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
    });

    const sleep = document.createElement("button");
    sleep.className = "icon-btn";
    sleep.innerHTML = ICONS.moon;
    sleep.title = i18n("sleepNow");
    sleep.disabled = t.discarded || t.active || t.locked;
    sleep.addEventListener("click", async () => {
      const r = await send({ type: "discardOne", tabId: t.id });
      if (!r?.ok) toast(i18n("cantSleep"));
      refresh();
    });

    const lock = document.createElement("button");
    lock.className = "icon-btn" + (t.locked ? " on" : "");
    lock.innerHTML = t.locked ? ICONS.lock : ICONS.unlock;
    lock.title = t.locked ? i18n("unlockTitle") : i18n("lockTitle");
    lock.addEventListener("click", async () => {
      const r = await send({ type: "setLock", tabId: t.id, locked: !t.locked });
      if (r?.ok) toast(t.locked ? i18n("unlockedToast") : i18n("lockedToast"));
      else toast(i18n("changeFailed"));
      refresh();
    });

    li.append(favicon(t), info, sleep, lock);
    ul.append(li);
  }
}

async function loadTabs() {
  const r = await send({ type: "tabsInfo" });
  if (!Array.isArray(r)) return;
  // kilitliler üstte, sonra uyanıklar (en çok bellek yiyen önce), en altta uyuyanlar
  r.sort(
    (a, b) =>
      b.locked - a.locked ||
      a.discarded - b.discarded ||
      (b.memory || 0) - (a.memory || 0)
  );
  tabs = r;
  renderAwake();
  renderTabs();
  runPopupHooks(RNP.afterTabs, tabs);
}

const refresh = () => Promise.all([renderStats(), loadTabs()]);

// --- olaylar ---------------------------------------------------------------

["enabled", "skipPinned", "skipAudible", "notify", "pressureMode"].forEach((id) =>
  $(id).addEventListener("change", () => save())
);
["minutes", "pressureThreshold", "pressureMinutes"].forEach((id) =>
  $(id).addEventListener("change", () => save())
);
$("whitelist").addEventListener("change", () => save());
document.querySelectorAll("[data-step]").forEach((b) =>
  b.addEventListener("click", (e) => {
    e.preventDefault();
    const input = b.closest(".stepper").querySelector("input");
    if (input.disabled) return;
    const base = parseInt(input.value, 10) || NUM_LIMITS[input.id][2];
    input.value = base + Number(b.dataset.step);
    save(true);
  })
);
$("search").addEventListener("input", renderTabs);

$("addCurrent").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try { host = new URL(tab.url).hostname.replace(/^www\./, ""); } catch {}
  if (!host || !/^https?:/.test(tab.url)) return toast(i18n("cantAddPage"));
  const list = parseWhitelist();
  if (!list.includes(host)) list.push(host);
  $("whitelist").value = list.join("\n");
  await save(true);
  toast(i18n("addedToList", host));
});

$("resetTotals").addEventListener("click", async () => {
  await send({ type: "resetTotals" });
  toast(i18n("totalsReset"));
  refresh();
});

$("discardNow").addEventListener("click", async () => {
  const r = await send({ type: "discardNow" });
  if (!r?.count) toast(i18n("nothingToSleep"));
  // artış baloncuğu renderStats içinde gösterilir
  refresh();
});

// Özellik betikleri (features/*.popup.js) bu dosyadan sonra yüklendiği için
// başlangıcı DOMContentLoaded'a bırakıyoruz; böylece kancaları hazır olur.
document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  for (const h of RNP.init) {
    try { await h(); } catch (e) { console.warn("Ramnesia popup init error", e); }
  }
  refresh();
  setInterval(refresh, 5000); // kalan süreleri ve kazancı güncel tut
});

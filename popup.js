const DEFAULTS = {
  enabled: true,
  minutes: 5,
  skipPinned: true,
  skipAudible: true,
  notify: false,
  whitelist: []
};

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function fmtBytes(b) {
  const mb = b / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(1).replace(".", ",") + " GB";
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

async function loadSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  $("enabled").checked = s.enabled;
  $("minutes").value = s.minutes;
  $("skipPinned").checked = s.skipPinned;
  $("skipAudible").checked = s.skipAudible;
  $("notify").checked = s.notify;
  $("whitelist").value = s.whitelist.join("\n");
  applyEnabled(s.enabled, s.minutes);
}

function applyEnabled(on, minutes) {
  $("modeText").textContent = on ? `${minutes} dk girilmeyen sekmeler uyutulur` : "Otomatik uyutma kapalı";
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
  let minutes = parseInt($("minutes").value, 10);
  if (!Number.isFinite(minutes) || minutes < 1) minutes = 1;
  if (minutes > 240) minutes = 240;
  $("minutes").value = minutes;
  const s = {
    enabled: $("enabled").checked,
    minutes,
    skipPinned: $("skipPinned").checked,
    skipAudible: $("skipAudible").checked,
    notify: $("notify").checked,
    whitelist: parseWhitelist()
  };
  await chrome.storage.sync.set(s);
  applyEnabled(s.enabled, s.minutes);
  if (!quiet) toast("Ayarlar kaydedildi");
  refresh();
}

// --- özet kartı ------------------------------------------------------------

let lastSavedNow = null;

async function renderStats() {
  const r = await send({ type: "stats" });
  if (!r || r.error) return;
  const el = $("savedNow");
  el.textContent = (r.hasEstimate ? "≈ " : "") + fmtBytes(r.savedNow);
  $("sleepCount").textContent = `${r.discarded} / ${r.total} sekme uyuyor`;
  $("totalSaved").textContent = `Toplam kazanç: ${fmtBytes(r.totals.bytes)}`;
  $("totalSaved").title = `Kurulumdan beri ${r.totals.count} kez sekme uyutuldu`;
  system = r.system;
  renderSystem();

  if (lastSavedNow != null && r.savedNow > lastSavedNow) {
    toast(`+${fmtBytes(r.savedNow - lastSavedNow)} bellek boşaltıldı`);
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
  }
  lastSavedNow = r.savedNow;
}

// --- sistem belleği + aktif sekmeler ----------------------------------------

let system = null;
let awakeBytes = 0;

function renderSystem() {
  if (!system) {
    $("sysUsed").textContent = "Bilinmiyor";
    return;
  }
  const used = system.capacity - system.available;
  const pct = Math.round((used / system.capacity) * 100);
  $("sysUsed").textContent = fmtBytes(used);
  $("sysCap").textContent = `/ ${fmtBytes(system.capacity)}`;
  $("sysPct").textContent = `%${pct}`;
  $("sysPct").classList.toggle("high", pct >= 85);
  $("sysFree").textContent = `${fmtBytes(system.available)} boş`;
  const tabsPct = Math.min(pct, (awakeBytes / system.capacity) * 100);
  $("meterTabs").style.width = `${tabsPct}%`;
  $("meterOther").style.width = `${pct - tabsPct}%`;
}

function renderAwake() {
  const awake = tabs.filter((t) => !t.discarded);
  const measured = awake.filter((t) => t.memory);
  awakeBytes = measured.reduce((a, t) => a + t.memory, 0);
  $("awakeMem").textContent = measured.length ? fmtBytes(awakeBytes) : "–";
  $("awakeCount").textContent = `${awake.length} sekme açık`;
  $("heroNote").textContent =
    "Sekme değerleri sayfaların ölçülen JS belleğidir; Chrome'un gerçek kullanımı genelde daha fazladır.";
  renderSystem();
}

// --- sekme listesi ---------------------------------------------------------

let tabs = [];

function statusParts(t) {
  if (t.discarded) {
    return t.saved
      ? [["good", `💤 Uyuyor`], ["", `${t.saved.estimated ? "≈ " : ""}${fmtBytes(t.saved.bytes)} boşaltıldı`]]
      : [["good", "💤 Uyuyor"]];
  }
  const mem = t.memory ? [["", fmtBytes(t.memory)]] : [];
  const map = {
    locked: ["lock", "Kilitli"],
    active: ["", "Şu an açık"],
    pinned: ["", "Sabitlenmiş"],
    audible: ["", "Ses çalıyor"],
    whitelist: ["", "Beyaz listede"]
  };
  if (t.reason) return [map[t.reason], ...mem];
  const min = Math.ceil(t.remainingMs / 60000);
  const when = t.remainingMs <= 60000 ? ["soon", "Birazdan uyuyacak"] : ["", `${min} dk sonra uyuyacak`];
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
    li.textContent = q ? "Eşleşen sekme yok" : "Açık web sitesi yok";
    ul.append(li);
    return;
  }

  for (const t of list) {
    const li = document.createElement("li");
    if (t.discarded) li.classList.add("sleeping");

    const info = document.createElement("div");
    info.className = "info";
    info.title = `${t.title}\n${t.host}\nSekmeye gitmek için tıkla`;
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
    sleep.title = "Şimdi uyut";
    sleep.disabled = t.discarded || t.active || t.locked;
    sleep.addEventListener("click", async () => {
      const r = await send({ type: "discardOne", tabId: t.id });
      if (!r?.ok) toast("Bu sekme uyutulamadı");
      refresh();
    });

    const lock = document.createElement("button");
    lock.className = "icon-btn" + (t.locked ? " on" : "");
    lock.innerHTML = t.locked ? ICONS.lock : ICONS.unlock;
    lock.title = t.locked ? "Kilidi kaldır (uyutulabilir)" : "Kilitle (asla uyutma)";
    lock.addEventListener("click", async () => {
      const r = await send({ type: "setLock", tabId: t.id, locked: !t.locked });
      if (r?.ok) toast(t.locked ? "Kilit kaldırıldı" : "Kilitlendi – bu sekme uyutulmayacak");
      else toast("Değiştirilemedi");
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
}

const refresh = () => Promise.all([renderStats(), loadTabs()]);

// --- olaylar ---------------------------------------------------------------

["enabled", "skipPinned", "skipAudible", "notify"].forEach((id) =>
  $(id).addEventListener("change", () => save())
);
$("minutes").addEventListener("change", () => save());
$("whitelist").addEventListener("change", () => save());
document.querySelectorAll("[data-step]").forEach((b) =>
  b.addEventListener("click", (e) => {
    e.preventDefault();
    $("minutes").value = (parseInt($("minutes").value, 10) || 1) + Number(b.dataset.step);
    save(true);
  })
);
$("search").addEventListener("input", renderTabs);

$("addCurrent").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try { host = new URL(tab.url).hostname.replace(/^www\./, ""); } catch {}
  if (!host || !/^https?:/.test(tab.url)) return toast("Bu sayfa eklenemez");
  const list = parseWhitelist();
  if (!list.includes(host)) list.push(host);
  $("whitelist").value = list.join("\n");
  await save(true);
  toast(`${host} listeye eklendi`);
});

$("resetTotals").addEventListener("click", async () => {
  await send({ type: "resetTotals" });
  toast("Toplam istatistik sıfırlandı");
  refresh();
});

$("discardNow").addEventListener("click", async () => {
  const r = await send({ type: "discardNow" });
  if (!r?.count) toast("Uyutulacak sekme yok");
  // artış baloncuğu renderStats içinde gösterilir
  refresh();
});

loadSettings().then(refresh);
setInterval(refresh, 5000); // kalan süreleri ve kazancı güncel tut

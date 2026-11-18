let tabs = [];

function statusParts(t) {
  if (t.discarded) {
    return t.saved
      ? [
          ["good", i18n("statusSleeping")],
          ["", i18n("freedAmount", approxPrefix(savedKind(t.saved)) + fmtBytes(t.saved.bytes)), kindTitle(savedKind(t.saved))]
        ]
      : [["good", i18n("statusSleeping")]];
  }
  const mem = t.memory ? [["", approxPrefix(awakeKind(t)) + fmtBytes(t.memory), kindTitle(awakeKind(t))]] : [];
  const map = {
    locked: ["lock", i18n("reasonLocked")],
    active: ["", i18n("reasonActive")],
    pinned: ["lock", i18n("reasonPinned")],
    audible: ["", i18n("reasonAudible")],
    whitelist: ["", i18n("reasonWhitelist")]
  };
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

const rowCache = new Map();

function rowSignature(t) {
  return JSON.stringify([t.title, t.host, t.favIconUrl, t.windowId, t.discarded, t.active, t.locked, t.pinProtected, statusParts(t)]);
}

function buildRow(t) {
  const li = document.createElement("li");
  if (t.discarded) li.classList.add("sleeping");

  const info = document.createElement("div");
  info.className = "info";
  info.title = `${t.title}\n${t.host}\n${i18n("clickToSwitch")}`;
  const title = Object.assign(document.createElement("div"), { className: "title", textContent: t.title });
  const status = document.createElement("div");
  status.className = "status";
  statusParts(t).forEach(([cls, text, tip], i) => {
    const span = document.createElement("span");
    if (i === 0 && cls !== undefined) span.className = "pill " + cls;
    if (tip) { span.title = tip; span.classList.add("mem"); }
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
  const lockedNow = t.locked || t.pinProtected;
  lock.className = "icon-btn" + (lockedNow ? " on" : "");
  lock.innerHTML = lockedNow ? ICONS.lock : ICONS.unlock;
  lock.title = t.pinProtected ? i18n("pinnedProtectedTitle") : t.locked ? i18n("unlockTitle") : i18n("lockTitle");
  lock.disabled = !!t.pinProtected;
  lock.addEventListener("click", async () => {
    const r = await send({ type: "setLock", tabId: t.id, locked: !t.locked });
    if (r?.ok) toast(t.locked ? i18n("unlockedToast") : i18n("lockedToast"));
    else toast(i18n("changeFailed"));
    refresh();
  });

  li.append(favicon(t), info, sleep, lock);
  return li;
}

function renderTabs() {
  const q = $("search").value.trim().toLowerCase();
  const list = tabs.filter((t) => !q || t.title.toLowerCase().includes(q) || t.host.includes(q));
  const ul = $("tabList");

  const ids = new Set(tabs.map((t) => t.id));
  for (const id of rowCache.keys()) if (!ids.has(id)) rowCache.delete(id);

  if (!list.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = q ? i18n("noMatch") : i18n("noTabs");
    ul.replaceChildren(li);
    return;
  }

  const rows = list.map((t) => {
    const sig = rowSignature(t);
    const hit = rowCache.get(t.id);
    if (hit && hit.sig === sig) return hit.li;
    const li = buildRow(t);
    rowCache.set(t.id, { li, sig });
    return li;
  });

  const cur = ul.children;
  const same = cur.length === rows.length && rows.every((li, i) => cur[i] === li);
  if (!same) ul.replaceChildren(...rows);
}

async function loadTabs() {
  const r = await send({ type: "tabsInfo" });
  if (!Array.isArray(r)) return;
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

$("search").addEventListener("input", renderTabs);

$("discardNow").addEventListener("click", async () => {
  const r = await send({ type: "discardNow" });
  if (!r?.count) toast(i18n("nothingToSleep"));
  refresh();
});

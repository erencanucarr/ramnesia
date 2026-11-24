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

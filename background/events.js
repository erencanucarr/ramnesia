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

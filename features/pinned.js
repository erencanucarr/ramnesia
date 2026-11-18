(() => {
  const KEY = "pinProtected";
  let chain = Promise.resolve();
  const queue = (fn) => (chain = chain.then(fn).catch((e) => console.warn("Ramnesia pinned", e)));

  const setAutoDiscardable = (tabId, value) =>
    chrome.tabs.update(tabId, { autoDiscardable: value }).catch(() => null);

  function syncPinned() {
    return queue(async () => {
      const s = await getSettings();
      const owned = new Set(await sget(KEY, []));
      const tabs = await chrome.tabs.query({});
      const lockedGroups = await sget("lockedGroups", {});
      const alive = new Set(tabs.map((t) => t.id));

      for (const t of tabs) {
        const protect = s.skipPinned && t.pinned;
        if (protect && t.autoDiscardable !== false) {
          if (await setAutoDiscardable(t.id, false)) owned.add(t.id);
        } else if (!protect && owned.has(t.id)) {
          owned.delete(t.id);
          const inLockedGroup = t.groupId >= 0 && !!lockedGroups[t.groupId];
          if (t.autoDiscardable === false && !inLockedGroup) await setAutoDiscardable(t.id, true);
        }
      }
      for (const id of owned) if (!alive.has(id)) owned.delete(id);
      await sset({ [KEY]: [...owned] });
    });
  }

  chrome.runtime.onInstalled.addListener(() => syncPinned());
  chrome.runtime.onStartup.addListener(() => syncPinned());
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.pinned) syncPinned();
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if ("pinned" in info) syncPinned();
  });
  chrome.tabs.onRemoved.addListener(() => syncPinned());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.skipPinned) syncPinned();
  });

  syncPinned();
})();

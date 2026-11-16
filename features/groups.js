Object.assign(DEFAULTS, {
  sleepCollapsedGroups: false
});

const GROUP_NONE = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;
const COLLAPSE_DELAY_MS = 400;

let groupQueue = Promise.resolve();
function withGroups(fn) {
  const run = groupQueue.then(async () => {
    const locked = await sget("lockedGroups", {});
    const res = await fn(locked);
    await sset({ lockedGroups: locked });
    return res;
  });
  groupQueue = run.catch((e) => console.warn("Ramnesia groups error", e));
  return run;
}

async function setAutoDiscardable(tabId, value) {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: value });
    return true;
  } catch {
    return false;
  }
}

function dropTabRecord(locked, tabId, keepGroup = null) {
  for (const [gid, ids] of Object.entries(locked)) {
    if (Number(gid) === keepGroup) continue;
    const i = ids.indexOf(tabId);
    if (i !== -1) {
      ids.splice(i, 1);
      return Number(gid);
    }
  }
  return null;
}

async function handleTabGroupChange(tab) {
  const tabId = tab.id;
  const groupId = tab.groupId ?? GROUP_NONE;
  await withGroups(async (locked) => {
    const target = groupId !== GROUP_NONE ? locked[groupId] : null;
    const alreadyListed = !!target && target.includes(tabId);
    const fromGroup = dropTabRecord(locked, tabId, target ? groupId : null);

    if (target) {
      if (alreadyListed) return;
      if (fromGroup != null) {
        target.push(tabId);
      } else if (tab.autoDiscardable !== false) {
        if (await setAutoDiscardable(tabId, false)) target.push(tabId);
      }
    } else if (fromGroup != null) {
      await setAutoDiscardable(tabId, true);
    }
  });
}

async function releaseGroup(locked, groupId) {
  const ids = locked[groupId] || [];
  delete locked[groupId];
  for (const tabId of ids) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      continue;
    }
    const g = tab.groupId ?? GROUP_NONE;
    if (g !== GROUP_NONE && g !== groupId && locked[g]) {
      if (!locked[g].includes(tabId)) locked[g].push(tabId);
    } else {
      await setAutoDiscardable(tabId, true);
    }
  }
}

async function lockGroup(groupId, lock) {
  return withGroups(async (locked) => {
    const tabs = await chrome.tabs.query({ groupId });
    let count = 0;
    if (lock) {
      const ids = locked[groupId] || [];
      for (const t of tabs) {
        if (t.autoDiscardable === false) continue;
        if (await setAutoDiscardable(t.id, false)) {
          if (!ids.includes(t.id)) ids.push(t.id);
          count++;
        }
      }
      locked[groupId] = ids;
    } else {
      const ids = new Set(locked[groupId] || []);
      for (const t of tabs) {
        if (ids.has(t.id) && (await setAutoDiscardable(t.id, true))) count++;
      }
      delete locked[groupId];
    }
    return { ok: true, count };
  });
}

async function pruneLockedGroups(existingIds) {
  const locked = await sget("lockedGroups", {});
  const stale = Object.keys(locked).map(Number).filter((id) => !existingIds.has(id));
  if (!stale.length) return;
  await withGroups(async (l) => {
    for (const id of stale) if (l[id]) await releaseGroup(l, id);
  });
}

if (chrome.tabGroups) {
  const lastCollapsed = new Map();

  chrome.tabGroups.onUpdated.addListener(async (group) => {
    const was = lastCollapsed.get(group.id);
    lastCollapsed.set(group.id, group.collapsed);
    if (!group.collapsed || was === true) return;
    const s = await getSettings();
    if (!s.enabled || !s.sleepCollapsedGroups) return;
    await new Promise((r) => setTimeout(r, COLLAPSE_DELAY_MS));
    try {
      const g = await chrome.tabGroups.get(group.id);
      if (!g.collapsed) return;
    } catch {
      return;
    }
    await sweep({ force: true, filter: (t) => t.groupId === group.id, source: "group" });
  });

  chrome.tabGroups.onRemoved.addListener((group) => {
    lastCollapsed.delete(group.id);
    withGroups(async (locked) => {
      if (locked[group.id]) await releaseGroup(locked, group.id);
    });
  });
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.groupId !== undefined) {
    handleTabGroupChange(tab);
  } else if (info.autoDiscardable === true) {
    withGroups(async (locked) => {
      dropTabRecord(locked, tabId);
    });
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.groupId != null && tab.groupId !== GROUP_NONE) handleTabGroupChange(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  withGroups(async (locked) => {
    dropTabRecord(locked, tabId);
  });
});

chrome.tabs.onReplaced.addListener((added, removed) => {
  withGroups(async (locked) => {
    for (const ids of Object.values(locked)) {
      const i = ids.indexOf(removed);
      if (i !== -1) ids[i] = added;
    }
  });
});

let lockedGroupsCache = null;
function lockedGroupsSnapshot() {
  if (!lockedGroupsCache) {
    lockedGroupsCache = sget("lockedGroups", {});
    setTimeout(() => (lockedGroupsCache = null), 300);
  }
  return lockedGroupsCache;
}

RN.tabExtras.push(async (tab) => {
  const g = tab.groupId ?? GROUP_NONE;
  if (g === GROUP_NONE) return { groupId: null, groupLocked: false };
  const locked = await lockedGroupsSnapshot();
  return { groupId: g, groupLocked: !!locked[g] };
});

RN.messages.groupsInfo = async () => {
  if (!chrome.tabGroups) return [];
  const [groups, tabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({})]);
  await pruneLockedGroups(new Set(groups.map((g) => g.id)));
  const locked = await sget("lockedGroups", {});

  const byGroup = new Map();
  for (const t of tabs) {
    if (t.groupId == null || t.groupId === GROUP_NONE || !isWeb(t.url)) continue;
    const e = byGroup.get(t.groupId) || { tabCount: 0, sleepingCount: 0, index: t.index };
    e.tabCount++;
    if (t.discarded) e.sleepingCount++;
    e.index = Math.min(e.index, t.index);
    byGroup.set(t.groupId, e);
  }

  return groups
    .filter((g) => byGroup.has(g.id))
    .map((g) => ({ g, e: byGroup.get(g.id) }))
    .sort((a, b) => a.g.windowId - b.g.windowId || a.e.index - b.e.index)
    .map(({ g, e }) => ({
      id: g.id,
      windowId: g.windowId,
      title: g.title || "",
      color: g.color,
      collapsed: !!g.collapsed,
      locked: !!locked[g.id],
      tabCount: e.tabCount,
      sleepingCount: e.sleepingCount
    }));
};

RN.messages.groupLock = async (msg) => {
  const groupId = Number(msg.groupId);
  if (!Number.isInteger(groupId) || groupId === GROUP_NONE) return { ok: false, count: 0 };
  return lockGroup(groupId, !!msg.locked);
};

RN.messages.groupSleep = async (msg) => {
  const groupId = Number(msg.groupId);
  if (!Number.isInteger(groupId) || groupId === GROUP_NONE) return { count: 0, bytes: 0 };
  const s = await getSettings();
  const tabs = await chrome.tabs.query({ groupId });
  const eligible = [];
  for (const t of tabs) {
    if (canDiscard(t, s) && !(await extraSkipReason(t, s))) eligible.push(t);
  }
  const { count, bytes } = await discardBatch(eligible, "group");
  await updateBadge();
  return { count, bytes };
};

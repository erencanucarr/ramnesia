// Ramnesia feature: tab groups (background). See RN hooks in background.js.
//
// 1) Sleep collapsed groups: collapsing a group puts its eligible tabs to sleep
//    right away (setting sleepCollapsedGroups, off by default).
// 2) Group lock: lock/unlock a whole group from the popup. Implemented with the
//    same autoDiscardable:false flag as the per-tab lock, so Chrome's own Memory
//    Saver also leaves those tabs alone.
// 3) Sleep a group now (popup button).
//
// Group-lock bookkeeping lives in chrome.storage.session under "lockedGroups":
//   { [groupId]: [tabId, ...] }
// The key set = locked groups; the array = tabs whose lock was set BY the group
// lock. Tabs the user had already locked individually are never listed, so
// unlocking the group / leaving it never unlocks them. Group and tab ids are only
// valid for one browser session, which matches storage.session's lifetime.

Object.assign(DEFAULTS, {
  sleepCollapsedGroups: false // collapse a tab group → put its tabs to sleep
});

const GROUP_NONE = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;
const COLLAPSE_DELAY_MS = 400; // let Chrome move the active tab out of the group first

// --- bookkeeping helpers ------------------------------------------------------

// All read-modify-write of "lockedGroups" goes through this queue so concurrent
// tab/group events can't overwrite each other's changes.
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
    return false; // tab closed meanwhile
  }
}

// Remove tabId from whichever locked group lists it (except keepGroup).
// Returns the group id it was removed from, or null.
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

// A tab is now in groupId (GROUP_NONE if ungrouped). Apply / release the group lock.
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
        // moved between two locked groups: the lock is still the group's doing
        target.push(tabId);
      } else if (tab.autoDiscardable !== false) {
        if (await setAutoDiscardable(tabId, false)) target.push(tabId);
      }
      // else: the user locked it individually → leave it alone, don't list it
    } else if (fromGroup != null) {
      // left a locked group (to no group or an unlocked group) → release our lock
      await setAutoDiscardable(tabId, true);
    }
  });
}

// Group gone (closed, ungrouped or merged): release tabs it locked unless they
// now sit in another locked group.
async function releaseGroup(locked, groupId) {
  const ids = locked[groupId] || [];
  delete locked[groupId];
  for (const tabId of ids) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      continue; // closed
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
        if (t.autoDiscardable === false) continue; // already locked (by user or by us)
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

// Drop entries for groups that no longer exist (e.g. events missed while the
// service worker was asleep in an unusual order).
async function pruneLockedGroups(existingIds) {
  const locked = await sget("lockedGroups", {});
  const stale = Object.keys(locked).map(Number).filter((id) => !existingIds.has(id));
  if (!stale.length) return;
  await withGroups(async (l) => {
    for (const id of stale) if (l[id]) await releaseGroup(l, id);
  });
}

// --- events (registered synchronously at top level) --------------------------

if (chrome.tabGroups) {
  const lastCollapsed = new Map(); // groupId → collapsed (in memory only)

  chrome.tabGroups.onUpdated.addListener(async (group) => {
    const was = lastCollapsed.get(group.id);
    lastCollapsed.set(group.id, group.collapsed);
    if (!group.collapsed || was === true) return; // only on the transition to collapsed
    const s = await getSettings();
    if (!s.enabled || !s.sleepCollapsedGroups) return;
    await new Promise((r) => setTimeout(r, COLLAPSE_DELAY_MS));
    try {
      const g = await chrome.tabGroups.get(group.id);
      if (!g.collapsed) return; // reopened already
    } catch {
      return; // group removed
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
    // user (or someone) unlocked a group-locked tab individually: the group no
    // longer holds its lock, so a later individual lock must survive leaving.
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

// --- hooks ---------------------------------------------------------------------

// tabsInfo calls this once per tab; share one storage read per popup refresh.
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

// --- messages ----------------------------------------------------------------

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

// { groupId, locked } → { ok, count }  (count = tabs whose lock flag changed)
RN.messages.groupLock = async (msg) => {
  const groupId = Number(msg.groupId);
  if (!Number.isInteger(groupId) || groupId === GROUP_NONE) return { ok: false, count: 0 };
  return lockGroup(groupId, !!msg.locked);
};

// { groupId } → { count, bytes }
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

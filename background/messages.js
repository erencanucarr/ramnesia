async function tabsInfo() {
  const s = await getSettings();
  const seen = await sget("seen", {});
  const saved = await sget("saved", {});
  const tabs = (await chrome.tabs.query({})).filter((t) => isWeb(t.url));
  const now = Date.now();
  const eff = await effectiveLimit(s);

  const budget = new Promise((r) => setTimeout(r, TABSINFO_BUDGET_MS));

  return Promise.all(
    tabs.map(async (t) => {
      const last = Math.max(seen[t.id] || 0, t.lastAccessed || 0) || now;
      const m = t.discarded
        ? null
        : await Promise.race([tabMemory(t), budget.then(() => tabMemory(t, { cachedOnly: true }))]);
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
        locked: t.autoDiscardable === false && !(s.skipPinned && t.pinned),
        pinProtected: !!(s.skipPinned && t.pinned),
        reason: skipReason(t, s) || (t.discarded ? null : await extraSkipReason(t, s)),
        memory: m?.bytes ?? null,
        memoryKind: m?.kind ?? null,
        heap: m?.heap ?? null,
        saved: saved[t.id] || null,
        remainingMs: Math.max(0, limitMsForTab(t, s, eff) - (now - last)),
        siteMinutes: siteRuleFor(t.url, s.siteRules)?.minutes ?? null
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

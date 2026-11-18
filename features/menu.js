(() => {
  const CONTEXTS = ["page", "action"];
  const SITE_CHOICES = [2, 5, 10, 15, 30, 60];
  const ID = {
    sleep: "rn-sleep-tab",
    others: "rn-sleep-others",
    sep1: "rn-sep-1",
    lock: "rn-lock-tab",
    never: "rn-never-site",
    site: "rn-site-time",
    siteDefault: "rn-site-default",
    siteMin: (m) => `rn-site-${m}`
  };

  const minutesLabel = (m) => (m === 60 ? i18n("menu_hour") : i18n("menu_minutes", m));

  async function createMenus() {
    await chrome.contextMenus.removeAll();
    const s = await getSettings();
    const add = (props) =>
      chrome.contextMenus.create({ contexts: CONTEXTS, ...props }, () => void chrome.runtime.lastError);
    add({ id: ID.sleep, title: i18n("menu_sleepTab") });
    add({ id: ID.others, title: i18n("menu_sleepOthers") });
    add({ id: ID.sep1, type: "separator" });
    add({ id: ID.lock, type: "checkbox", title: i18n("menu_lockTab"), checked: false });
    add({ id: ID.never, type: "checkbox", title: i18n("menu_neverSite"), checked: false });
    add({ id: ID.site, title: i18n("menu_siteTime") });
    add({ id: ID.siteDefault, parentId: ID.site, type: "radio", title: i18n("menu_siteDefault", s.minutes), checked: true });
    for (const m of SITE_CHOICES) {
      add({ id: ID.siteMin(m), parentId: ID.site, type: "radio", title: minutesLabel(m), checked: false });
    }
    await syncMenus();
  }

  const update = (id, props) =>
    new Promise((r) => chrome.contextMenus.update(id, props, () => { void chrome.runtime.lastError; r(); }));

  async function activeTab() {
    try {
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return t || null;
    } catch {
      return null;
    }
  }

  async function syncMenus(tab) {
    tab = tab || (await activeTab());
    const s = await getSettings();
    const web = !!tab && isWeb(tab.url);
    const host = web ? hostOf(tab.url) : "";
    const rule = web ? siteRuleFor(tab.url, s.siteRules) : null;
    try {
      await Promise.all([
        update(ID.sleep, { enabled: web }),
        update(ID.others, { enabled: !!tab }),
        update(ID.lock, { enabled: web && !(s.skipPinned && tab.pinned), checked: !!tab && tab.autoDiscardable === false }),
        update(ID.never, {
          enabled: web,
          checked: web && isWhitelisted(tab.url, s.whitelist),
          title: host ? i18n("menu_neverSiteHost", host) : i18n("menu_neverSite")
        }),
        update(ID.site, {
          enabled: web,
          title: host ? i18n("menu_siteTimeHost", host) : i18n("menu_siteTime")
        }),
        update(ID.siteDefault, {
          title: i18n("menu_siteDefault", s.minutes),
          checked: !rule || !SITE_CHOICES.includes(rule.minutes)
        }),
        ...SITE_CHOICES.map((m) => update(ID.siteMin(m), { checked: rule?.minutes === m }))
      ]);
    } catch {}
  }

  async function sleepThisTab(tab) {
    if (!tab || !isWeb(tab.url)) return;
    const others = (await chrome.tabs.query({ windowId: tab.windowId })).filter((t) => t.id !== tab.id);
    if (!others.length) return;
    others.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    await chrome.tabs.update(others[0].id, { active: true });
    const fresh = await chrome.tabs.get(tab.id);
    await discardBatch([fresh], "manual");
    await updateBadge();
  }

  async function sleepOthers(tab) {
    if (!tab) return;
    await sweep({
      force: true,
      source: "menu",
      filter: (t) => t.windowId === tab.windowId && t.id !== tab.id
    });
  }

  async function setLock(tab, locked) {
    if (!tab) return;
    await chrome.tabs.update(tab.id, { autoDiscardable: !locked });
  }

  async function setNeverSite(tab, never) {
    const host = tab && isWeb(tab.url) ? hostOf(tab.url) : "";
    if (!host) return;
    const s = await getSettings();
    let list = (s.whitelist || []).filter((d) => {
      d = String(d).trim().toLowerCase().replace(/^www\./, "");
      return never ? true : !(host === d || host.endsWith("." + d));
    });
    if (never && !isWhitelisted(tab.url, list)) list = [...list, host];
    await chrome.storage.sync.set({ whitelist: list });
  }

  async function setSiteTime(tab, minutes) {
    const host = tab && isWeb(tab.url) ? hostOf(tab.url) : "";
    if (!host) return;
    const s = await getSettings();
    const current = siteRuleFor(tab.url, s.siteRules);
    const key = current?.host || host;
    let rules = (s.siteRules || []).filter(
      (r) => String(r?.host || "").trim().toLowerCase().replace(/^www\./, "") !== key
    );
    if (minutes) rules = [...rules, { host: key, minutes }];
    await chrome.storage.sync.set({ siteRules: rules });
  }

  chrome.contextMenus.onClicked.addListener(async (info, clicked) => {
    const tab = clicked && clicked.id >= 0 ? clicked : await activeTab();
    try {
      switch (info.menuItemId) {
        case ID.sleep:
          await sleepThisTab(tab);
          break;
        case ID.others:
          await sleepOthers(tab);
          break;
        case ID.lock:
          await setLock(tab, !!info.checked);
          break;
        case ID.never:
          await setNeverSite(tab, !!info.checked);
          break;
        case ID.siteDefault:
          await setSiteTime(tab, null);
          break;
        default: {
          const m = SITE_CHOICES.find((x) => info.menuItemId === ID.siteMin(x));
          if (m) await setSiteTime(tab, m);
        }
      }
    } catch (e) {
      console.warn("Ramnesia menu action failed", e);
    }
    syncMenus();
  });

  chrome.runtime.onInstalled.addListener(() => createMenus());
  chrome.runtime.onStartup.addListener(() => createMenus());
  chrome.tabs.onActivated.addListener(() => syncMenus());
  chrome.windows?.onFocusChanged?.addListener(() => syncMenus());
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (tab.active && ("url" in info || "autoDiscardable" in info || "pinned" in info)) syncMenus(tab);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && (changes.whitelist || changes.siteRules || changes.minutes || changes.skipPinned)) syncMenus();
  });
})();

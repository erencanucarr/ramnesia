// Ramnesia feature: tab groups (popup). See RNP hooks in popup.js.
// Renders #groupSection (one compact row per tab group) and a settings toggle.

(() => {
  // Chrome's tabGroups.Color names → close to the colors Chrome draws
  const GROUP_COLORS = {
    grey: "#5f6368",
    blue: "#1a73e8",
    red: "#d93025",
    yellow: "#f9ab00",
    green: "#188038",
    pink: "#d01884",
    purple: "#a142f4",
    cyan: "#007b83",
    orange: "#fa903e"
  };

  const GROUP_SETTING_DEFAULTS = { sleepCollapsedGroups: false };
  let groupsBusy = false; // ignore refresh re-renders while an action is running

  // --- settings toggle -----------------------------------------------------------

  function buildSettings() {
    const host = $("featureSettings");
    if (!host) return;
    const row = document.createElement("label");
    row.className = "row";
    const text = document.createElement("span");
    const name = Object.assign(document.createElement("span"), {
      textContent: i18n("groups_collapseLabel")
    });
    const hint = Object.assign(document.createElement("small"), {
      className: "hint",
      textContent: i18n("groups_collapseHint")
    });
    text.append(name, hint);
    const input = Object.assign(document.createElement("input"), {
      type: "checkbox",
      id: "sleepCollapsedGroups",
      className: "toggle"
    });
    row.append(text, input);
    host.append(row);

    input.addEventListener("change", async () => {
      await chrome.storage.sync.set({ sleepCollapsedGroups: input.checked });
      toast(i18n("settingsSaved"));
      refresh();
    });
  }

  RNP.init.push(async () => {
    buildSettings();
    const s = await chrome.storage.sync.get(GROUP_SETTING_DEFAULTS);
    const input = $("sleepCollapsedGroups");
    if (input) input.checked = !!s.sleepCollapsedGroups;
  });

  // --- group list ------------------------------------------------------------------

  function subLine(g) {
    const parts = [g.tabCount === 1 ? i18n("groups_tabsOne") : i18n("groups_tabsMany", g.tabCount)];
    if (g.sleepingCount) parts.push(i18n("groups_asleep", g.sleepingCount));
    return parts.join(" · ");
  }

  function groupRow(g) {
    const li = document.createElement("li");
    if (g.tabCount && g.sleepingCount === g.tabCount) li.classList.add("sleeping");

    const dot = document.createElement("span");
    dot.className = "rn-group-dot";
    dot.style.background = GROUP_COLORS[g.color] || GROUP_COLORS.grey;

    const info = document.createElement("div");
    info.className = "info";
    const title = Object.assign(document.createElement("div"), {
      className: "title",
      textContent: g.title || i18n("groups_unnamed")
    });
    if (!g.title) title.classList.add("unnamed");
    const status = document.createElement("div");
    status.className = "status";
    if (g.locked) {
      status.append(Object.assign(document.createElement("span"), {
        className: "pill lock",
        textContent: i18n("groups_lockedPill")
      }));
    }
    status.append(Object.assign(document.createElement("span"), { textContent: subLine(g) }));
    info.append(title, status);
    info.title = `${title.textContent}\n${subLine(g)}`;

    const sleep = document.createElement("button");
    sleep.className = "icon-btn";
    sleep.innerHTML = ICONS.moon;
    sleep.title = i18n("groups_sleepTitle");
    sleep.disabled = g.locked || g.sleepingCount >= g.tabCount;
    sleep.addEventListener("click", () =>
      act(async () => {
        const r = await send({ type: "groupSleep", groupId: g.id });
        if (r?.count) toast(i18n("groups_sleptToast", r.count, fmtBytes(r.bytes)));
        else toast(i18n("groups_nothingToSleep"));
      })
    );

    const lock = document.createElement("button");
    lock.className = "icon-btn" + (g.locked ? " on" : "");
    lock.innerHTML = g.locked ? ICONS.lock : ICONS.unlock;
    lock.title = g.locked ? i18n("groups_unlockTitle") : i18n("groups_lockTitle");
    lock.addEventListener("click", () =>
      act(async () => {
        const r = await send({ type: "groupLock", groupId: g.id, locked: !g.locked });
        if (r?.ok) toast(g.locked ? i18n("groups_unlockedToast") : i18n("groups_lockedToast"));
        else toast(i18n("changeFailed"));
      })
    );

    li.append(dot, info, sleep, lock);
    return li;
  }

  async function act(fn) {
    groupsBusy = true;
    try {
      await fn();
    } catch {
      toast(i18n("changeFailed"));
    } finally {
      groupsBusy = false;
      refresh(); // re-renders tabs, then groups via afterTabs
    }
  }

  async function renderGroups() {
    const host = $("groupSection");
    if (!host) return;
    let groups;
    try {
      groups = await send({ type: "groupsInfo" });
    } catch {
      return;
    }
    if (groupsBusy) return;
    if (!Array.isArray(groups) || !groups.length) {
      host.replaceChildren();
      host.hidden = true;
      return;
    }

    const head = document.createElement("div");
    head.className = "rn-groups-head";
    head.append(
      Object.assign(document.createElement("span"), { textContent: i18n("groups_title") }),
      Object.assign(document.createElement("span"), {
        className: "rn-groups-count",
        textContent: String(groups.length)
      })
    );
    const ul = document.createElement("ul");
    ul.className = "rn-groups";
    groups.forEach((g) => ul.append(groupRow(g)));

    host.replaceChildren(head, ul);
    host.hidden = false;
  }

  RNP.afterTabs.push(() => {
    renderGroups();
  });
})();

const cleanHost = (v) =>
  String(v || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#:].*$/, "")
    .replace(/^www\./, "");
const isHostLike = (h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || h === "localhost";
const clampSiteMinutes = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(1440, Math.max(1, n)) : 30;
};

async function saveSiteRules(rules, toastText) {
  await chrome.storage.sync.set({ siteRules: rules });
  current = { ...current, siteRules: rules };
  renderSiteRules();
  if (toastText) toast(toastText);
  refresh();
}

function renderSiteRules() {
  const rules = (current.siteRules || []).slice().sort((a, b) => a.host.localeCompare(b.host));
  const ul = $("siteRules");
  if (!rules.length) {
    ul.replaceChildren(Object.assign(document.createElement("li"), { className: "empty hint", textContent: i18n("siteTimesEmpty") }));
    return;
  }
  ul.replaceChildren(
    ...rules.map((r) => {
      const li = document.createElement("li");
      const host = Object.assign(document.createElement("span"), { className: "site-host", textContent: r.host, title: r.host });
      const input = Object.assign(document.createElement("input"), { type: "number", min: 1, max: 1440, value: r.minutes });
      input.addEventListener("change", () => {
        const m = clampSiteMinutes(input.value);
        input.value = m;
        saveSiteRules(
          (current.siteRules || []).map((x) => (x.host === r.host ? { host: x.host, minutes: m } : x)),
          i18n("siteTimeSaved", r.host, m)
        );
      });
      const unit = Object.assign(document.createElement("em"), { textContent: i18n("unitMinutes") });
      const stepper = Object.assign(document.createElement("span"), { className: "stepper" });
      stepper.append(input, unit);
      const del = Object.assign(document.createElement("button"), {
        type: "button",
        className: "icon-btn",
        title: i18n("siteTimesRemove"),
        innerHTML: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>'
      });
      del.addEventListener("click", () =>
        saveSiteRules((current.siteRules || []).filter((x) => x.host !== r.host), i18n("siteTimeRemoved", r.host))
      );
      li.append(host, stepper, del);
      return li;
    })
  );
}

async function addSiteRule() {
  const host = cleanHost($("siteRuleHost").value);
  if (!isHostLike(host)) {
    toast(i18n("siteTimesInvalid"));
    $("siteRuleHost").focus();
    return;
  }
  const minutes = clampSiteMinutes($("siteRuleMinutes").value);
  const rules = (current.siteRules || []).filter((x) => x.host !== host);
  rules.push({ host, minutes });
  $("siteRuleHost").value = "";
  await saveSiteRules(rules, i18n("siteTimeSaved", host, minutes));
}

$("siteRuleAdd").addEventListener("click", addSiteRule);
$("siteRuleHost").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addSiteRule();
});
$("siteRuleCurrent").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try { host = /^https?:/.test(tab.url) ? new URL(tab.url).hostname.replace(/^www\./, "") : ""; } catch {}
  if (!host) return toast(i18n("cantAddPage"));
  $("siteRuleHost").value = host;
  $("siteRuleMinutes").focus();
});

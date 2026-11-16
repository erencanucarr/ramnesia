let current = { ...DEFAULTS };
let pressure = { active: false, minutes: null };

function readNum(id) {
  const [min, max, def] = NUM_LIMITS[id];
  let n = parseInt($(id).value, 10);
  if (!Number.isFinite(n)) n = def;
  n = Math.min(max, Math.max(min, n));
  $(id).value = n;
  return n;
}

async function loadSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  $("enabled").checked = s.enabled;
  $("minutes").value = s.minutes;
  $("skipPinned").checked = s.skipPinned;
  $("skipAudible").checked = s.skipAudible;
  $("notify").checked = s.notify;
  $("pressureMode").checked = s.pressureMode;
  $("pressureThreshold").value = s.pressureThreshold;
  $("pressureMinutes").value = s.pressureMinutes;
  $("whitelist").value = s.whitelist.join("\n");
  current = s;
  renderSiteRules();
  readNum("pressureThreshold");
  readNum("pressureMinutes");
  applyPressureOpts(s.pressureMode);
  renderMode();
}

function applyPressureOpts(on) {
  $("pressureOpts").hidden = !on;
  $("pressureOpts").querySelectorAll("input, button").forEach((el) => (el.disabled = !on));
}

function renderMode() {
  const active = current.enabled && current.pressureMode && pressure.active;
  let text;
  if (!current.enabled) text = i18n("modeOff");
  else if (active) text = i18n("modeOnPressure", pressure.minutes ?? Math.min(current.minutes, current.pressureMinutes));
  else text = i18n("modeOnMinutes", current.minutes);
  $("modeText").textContent = text;
  $("pressurePill").hidden = !active;
  $("pressurePill").title = active ? i18n("pressurePillTitle", current.pressureThreshold) : "";
}

function parseWhitelist() {
  return [...new Set(
    $("whitelist").value
      .split(/\s+/)
      .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, ""))
      .filter(Boolean)
  )];
}

async function save(quiet) {
  const s = {
    enabled: $("enabled").checked,
    minutes: readNum("minutes"),
    skipPinned: $("skipPinned").checked,
    skipAudible: $("skipAudible").checked,
    notify: $("notify").checked,
    pressureMode: $("pressureMode").checked,
    pressureThreshold: readNum("pressureThreshold"),
    pressureMinutes: readNum("pressureMinutes"),
    whitelist: parseWhitelist()
  };
  await chrome.storage.sync.set(s);
  current = { ...current, ...s };
  applyPressureOpts(s.pressureMode);
  renderMode();
  if (!quiet) toast(i18n("settingsSaved"));
  refresh();
}

["enabled", "skipPinned", "skipAudible", "notify", "pressureMode"].forEach((id) =>
  $(id).addEventListener("change", () => save())
);
["minutes", "pressureThreshold", "pressureMinutes"].forEach((id) =>
  $(id).addEventListener("change", () => save())
);
$("whitelist").addEventListener("change", () => save());
document.querySelectorAll("[data-step]").forEach((b) =>
  b.addEventListener("click", (e) => {
    e.preventDefault();
    const input = b.closest(".stepper").querySelector("input");
    if (input.disabled) return;
    const base = parseInt(input.value, 10) || NUM_LIMITS[input.id][2];
    input.value = base + Number(b.dataset.step);
    save(true);
  })
);

$("addCurrent").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try { host = new URL(tab.url).hostname.replace(/^www\./, ""); } catch {}
  if (!host || !/^https?:/.test(tab.url)) return toast(i18n("cantAddPage"));
  const list = parseWhitelist();
  if (!list.includes(host)) list.push(host);
  $("whitelist").value = list.join("\n");
  await save(true);
  toast(i18n("addedToList", host));
});

$("resetTotals").addEventListener("click", async () => {
  await send({ type: "resetTotals" });
  toast(i18n("totalsReset"));
  refresh();
});

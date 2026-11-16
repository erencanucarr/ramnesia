let lastSavedNow = null;
let lastStats = null;

function renderFreed() {
  if (!lastStats) return;
  const approx =
    !!lastStats.hasEstimate ||
    tabs.some((t) => t.discarded && t.saved && isApprox(savedKind(t.saved)));
  setTileValue($("savedNow"), fmtBytes(lastStats.savedNow), approx);
}

async function renderStats() {
  const r = await send({ type: "stats" });
  if (!r || r.error) return;
  const el = $("savedNow");
  lastStats = r;
  renderFreed();
  $("sleepCount").textContent = i18n("sleepingOfTotal", r.discarded, r.total);
  $("totalSaved").textContent = i18n("totalGain", "≈ " + fmtBytes(r.totals.bytes));
  $("totalSaved").title = i18n("totalGainTitle", r.totals.count);
  system = r.system;
  calibration = r.calibration || null;
  pressure = { active: !!r.pressureActive, minutes: r.effectiveMinutes ?? null };
  renderMode();
  renderSystem();
  renderNote();

  if (lastSavedNow != null && r.savedNow > lastSavedNow) {
    toast(i18n("freedToast", fmtBytes(r.savedNow - lastSavedNow)));
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
  }
  lastSavedNow = r.savedNow;
  runPopupHooks(RNP.afterStats, r);
}

let system = null;
let awakeBytes = 0;
let calibration = null;

function renderSystem() {
  if (!system) {
    $("sysUsed").textContent = i18n("unknown");
    return;
  }
  const used = system.capacity - system.available;
  const pct = Math.round((used / system.capacity) * 100);
  $("sysUsed").textContent = fmtBytes(used);
  $("sysCap").textContent = `/ ${fmtBytes(system.capacity)}`;
  $("sysPct").textContent = i18n("percentValue", pct);
  $("sysPct").classList.toggle("high", pct >= (current.pressureMode ? current.pressureThreshold : 85));
  $("sysFree").textContent = i18n("freeMemory", fmtBytes(system.available));
  const tabsPct = Math.min(pct, (awakeBytes / system.capacity) * 100);
  $("meterTabs").style.width = `${tabsPct}%`;
  $("meterOther").style.width = `${pct - tabsPct}%`;
}

function renderAwake() {
  const awake = tabs.filter((t) => !t.discarded);
  const measured = awake.filter((t) => t.memory);
  awakeBytes = measured.reduce((a, t) => a + t.memory, 0);
  const approx = measured.length < awake.length || measured.some((t) => isApprox(awakeKind(t)));
  if (measured.length) setTileValue($("awakeMem"), fmtBytes(awakeBytes), approx);
  else setTileValue($("awakeMem"), "–", false);
  $("awakeCount").textContent = i18n("awakeCount", awake.length);
  renderSystem();
  renderFreed();
  renderNote();
}

function renderNote() {
  const kinds = new Set();
  for (const t of tabs) {
    if (t.discarded) { if (t.saved) kinds.add(savedKind(t.saved)); }
    else if (t.memory) kinds.add(awakeKind(t));
  }
  const allExact = kinds.size === 1 && kinds.has("exact");
  const factor = calibration?.factor;
  let text = "";
  if (!kinds.size) text = "";
  else if (allExact) text = i18n("noteExact");
  else if (kinds.has("exact") || kinds.has("shared")) text = i18n("noteChrome");
  else if (calibration?.ready && kinds.has("calibrated") && Number.isFinite(factor))
    text = i18n("noteCalibrated", factor.toFixed(1).replace(".", DECIMAL_SEP));
  else if (calibration && !calibration.ready) text = i18n("noteLearning");
  else text = i18n("noteHeap");
  $("heroNoteText").textContent = text;
  $("heroNote").hidden = !text;
  $("heroNote").title = text && !allExact ? i18n("approxTitle") : "";
}

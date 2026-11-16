// Ramnesia feature: calibrate (popup). See RNP hooks in popup.js.
// Shows the calibration status (real RAM / JS heap factor learned from realgain
// measurements) in the Statistics card of the settings view, with a reset button.
(() => {
  let row = null;
  let hint = null;
  let btn = null;

  const fmtFactor = (f) => (Number.isFinite(f) ? f : 1).toFixed(1).replace(".", DECIMAL_SEP);

  RNP.init.push(() => {
    const card =
      $("resetTotals")?.closest(".set-card") ||
      [...document.querySelectorAll("#settingsView .set-card")].pop();
    if (!card) return;

    const style = document.createElement("style");
    style.textContent = `
      .calibrate-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
      .calibrate-row[hidden] { display: none; }
      .calibrate-row .hint { flex: 1; min-width: 0; cursor: help; }
      .calibrate-row button.ghost { flex: none; padding: 2px 4px; border: none; font-size: 11px; }
      .calibrate-row button.ghost:hover { text-decoration: underline; }
      .calibrate-row button.ghost[hidden] { display: none; }`;
    document.head.append(style);

    row = document.createElement("div");
    row.className = "calibrate-row";
    row.hidden = true;
    hint = document.createElement("small");
    hint.className = "hint";
    hint.title = i18n("calibrate_title");
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost";
    btn.textContent = i18n("calibrate_reset");
    btn.addEventListener("click", async () => {
      const r = await chrome.runtime.sendMessage({ type: "calibrationReset" });
      toast(i18n(r?.ok ? "calibrate_resetToast" : "changeFailed"));
      refresh();
    });
    row.append(hint, btn);
    card.append(row);
  });

  RNP.afterStats.push((r) => {
    if (!row) return;
    const c = r.calibration;
    if (!c) {
      row.hidden = true;
      return;
    }
    hint.textContent = c.ready
      ? i18n("calibrate_status", c.samples, fmtFactor(c.factor))
      : i18n("calibrate_pending", c.samples, c.needed ?? 3);
    btn.hidden = !c.samples;
    row.hidden = false;
  });
})();

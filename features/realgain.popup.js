// Ramnesia feature: realgain (popup). See RNP hooks in popup.js.
// Shows the measured real RAM gain (change in free system memory after a batch of
// discards) inside the hero card, toasts new measurements, and adds a reset button.
(() => {
  let line = null;
  let state = { realLast: null, realTotals: null };
  let seenAt = null; // realLast.at already shown; null = not initialised yet

  function render() {
    if (!line) return;
    const { realLast, realTotals } = state;
    const hasTotal = (realTotals?.batches || 0) > 0;
    if (!realLast && !hasTotal) {
      line.hidden = true;
      return;
    }
    const total = fmtBytes(realTotals?.bytes || 0);
    line.textContent = realLast
      ? i18n("realgain_line", fmtBytes(realLast.bytes), total)
      : i18n("realgain_lineTotal", total);
    line.title = i18n("realgain_title", realTotals?.batches || 0);
    line.hidden = false;
  }

  function maybeToast() {
    const at = state.realLast?.at ?? 0;
    if (seenAt != null && at > seenAt) toast(i18n("realgain_toast", fmtBytes(state.realLast.bytes)));
    seenAt = Math.max(seenAt ?? 0, at);
  }

  function update(partial) {
    Object.assign(state, partial);
    render();
    maybeToast();
  }

  RNP.init.push(() => {
    line = document.createElement("div");
    line.id = "realgainLine";
    line.className = "realgain-line";
    line.hidden = true;
    $("heroExtra").append(line);

    // Ölçülen toplam, ayarlardaki "Toplamı sıfırla" ile birlikte sıfırlanır.
  });

  RNP.afterStats.push((r) => {
    if (!("realTotals" in r)) return;
    update({ realLast: r.realLast || null, realTotals: r.realTotals || null });
  });

  // A measurement finishes a few seconds after the discard: react right away instead
  // of waiting for the popup's 5 s refresh.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.realLast) update({ realLast: changes.realLast.newValue || null });
    if (area === "local" && changes.realTotals) update({ realTotals: changes.realTotals.newValue || null });
  });
})();

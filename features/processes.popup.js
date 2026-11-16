// Ramnesia feature: processes (popup). See RNP hooks in popup.js.
// Only on browsers with chrome.processes (Chrome Dev/Canary): adds a row to the "General"
// settings card showing whether exact per-tab memory is on, with a button to grant (or
// drop) the optional "processes" permission. permissions.request needs a user gesture,
// which is why it lives here and not in the background. Elsewhere it renders nothing.
(() => {
  const PERM = { permissions: ["processes"] };
  let row = null;
  let stateEl = null;
  let btn = null;
  let granted = null;

  function build() {
    const card = document.querySelector("#settingsView .set-card");
    if (!card) return false;
    row = document.createElement("div");
    row.className = "row";
    row.id = "processesRow";

    const text = document.createElement("span");
    const label = document.createElement("span");
    label.textContent = i18n("processes_label") + ": ";
    stateEl = document.createElement("strong");
    label.append(stateEl);
    const hint = document.createElement("small");
    hint.className = "hint";
    hint.textContent = i18n("processes_hint");
    text.append(label, hint);

    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost";
    btn.style.flex = "0 0 auto";
    btn.style.padding = "4px 10px";
    btn.addEventListener("click", toggle);

    row.append(text, btn);
    card.append(row);
    return true;
  }

  function render(st) {
    if (!st?.supported) {
      if (row) row.hidden = true;
      return;
    }
    if (!row && !build()) return;
    row.hidden = false;
    granted = !!st.granted;
    stateEl.textContent = i18n(granted ? "processes_on" : "processes_off");
    btn.textContent = i18n(granted ? "processes_disable" : "processes_enable");
    btn.title = granted ? "" : i18n("processes_enableTitle");
  }

  async function toggle() {
    btn.disabled = true;
    try {
      if (!granted) {
        // Must run straight from the click (user gesture).
        const ok = await chrome.permissions.request(PERM);
        toast(i18n(ok ? "processes_enabledToast" : "processes_deniedToast"));
      } else {
        await chrome.permissions.remove(PERM);
        toast(i18n("processes_disabledToast"));
      }
    } catch (e) {
      console.warn("Ramnesia processes permission error", e);
      toast(i18n("processes_failedToast"));
    } finally {
      btn.disabled = false;
    }
    try {
      render(await send({ type: "processesStatus" }));
    } catch {}
    refresh();
  }

  // Beklenmez (await yok): ilk açılışta yoklama yavaş olabilir, popup'ın ilk yenilemesini bekletmesin.
  RNP.init.push(() => {
    send({ type: "processesStatus" })
      .then((st) => { if (st && !st.error) render(st); })
      .catch(() => {});
  });

  RNP.afterStats.push((r) => {
    if (r?.processes) render(r.processes);
  });
})();

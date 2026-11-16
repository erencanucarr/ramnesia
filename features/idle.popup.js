// Ramnesia feature: idle (popup). See RNP hooks in popup.js.
// Ayarlar bölümüne "Uzaktayken" alt başlığı, iki anahtar ve dakika ayarı ekler.

(() => {
  const IDLE_DEFAULTS = { sleepOnLock: false, sleepOnIdle: false, idleMinutes: 10 };
  const IDLE_MIN = 1;
  const IDLE_MAX = 120;

  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    n.append(...kids);
    return n;
  };

  // --- arayüz ---------------------------------------------------------------
  const lockBox = el("input", { type: "checkbox", id: "idleSleepOnLock", className: "toggle" });
  const idleBox = el("input", { type: "checkbox", id: "idleSleepOnIdle", className: "toggle" });
  const minInput = el("input", { type: "number", id: "idleMinutes", min: IDLE_MIN, max: IDLE_MAX, step: 1 });
  const minus = el("button", { type: "button", textContent: "−" });
  const plus = el("button", { type: "button", textContent: "+" });
  minus.dataset.idleStep = "-1"; // data-step değil: popup.js'in bağlamasına takılmasın
  plus.dataset.idleStep = "1";

  const opts = el(
    "div",
    { id: "idleOpts", className: "indent", hidden: true },
    el(
      "label",
      { className: "row" },
      el("span", { textContent: i18n("idle_idleAfter") }),
      el("span", { className: "stepper" }, minus, minInput, plus, el("em", { textContent: i18n("unitMinutes") }))
    )
  );
  const last = el("small", { id: "idleLast", className: "hint idle-last", hidden: true });

  const section = el(
    "div",
    { id: "idleSettings", className: "idle-settings" },
    el("div", { className: "sub", textContent: i18n("idle_title") }),
    el("small", { className: "hint", textContent: i18n("idle_hint") }),
    el("label", { className: "row" }, el("span", { textContent: i18n("idle_sleepOnLock") }), lockBox),
    el(
      "label",
      { className: "row" },
      el(
        "span",
        {},
        el("span", { textContent: i18n("idle_sleepOnIdle") }),
        el("small", { className: "hint", textContent: i18n("idle_sleepOnIdleHint") })
      ),
      idleBox
    ),
    opts,
    last
  );
  $("featureSettings")?.append(section);

  // --- ayarlar --------------------------------------------------------------
  const clampMin = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(IDLE_MAX, Math.max(IDLE_MIN, n)) : IDLE_DEFAULTS.idleMinutes;
  };

  function applyOpts(on) {
    opts.hidden = !on;
    opts.querySelectorAll("input, button").forEach((n) => (n.disabled = !on));
  }

  async function load() {
    const s = { ...IDLE_DEFAULTS, ...(await chrome.storage.sync.get(IDLE_DEFAULTS)) };
    lockBox.checked = !!s.sleepOnLock;
    idleBox.checked = !!s.sleepOnIdle;
    minInput.value = clampMin(s.idleMinutes);
    applyOpts(idleBox.checked);
  }

  async function save(quiet) {
    const s = {
      sleepOnLock: lockBox.checked,
      sleepOnIdle: idleBox.checked,
      idleMinutes: clampMin(minInput.value)
    };
    minInput.value = s.idleMinutes;
    await chrome.storage.sync.set(s);
    applyOpts(s.sleepOnIdle);
    if (!quiet) toast(i18n("settingsSaved"));
    refresh();
  }

  lockBox.addEventListener("change", () => save());
  idleBox.addEventListener("change", () => save());
  minInput.addEventListener("change", () => save());
  [minus, plus].forEach((b) =>
    b.addEventListener("click", (e) => {
      e.preventDefault();
      if (minInput.disabled) return;
      const dir = Number(b.dataset.idleStep);
      const v = clampMin(minInput.value);
      // 10 dk altında 1'er, üstünde 5'er adım
      const step = v < 10 || (v === 10 && dir < 0) ? 1 : 5;
      minInput.value = clampMin(v + dir * step);
      save(true);
    })
  );

  RNP.init.push(load);

  // --- son uzakta-uyutma ----------------------------------------------------
  RNP.afterStats.push((r) => {
    const x = r?.idleLast;
    if (!x || !x.count) {
      last.hidden = true;
      return;
    }
    last.textContent = i18n("idle_lastSweep", x.count, fmtBytes(x.bytes || 0));
    last.title = new Date(x.at).toLocaleString(chrome.i18n.getUILanguage());
    last.hidden = false;
  });
})();

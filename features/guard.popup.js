// Ramnesia feature: guard (popup). Ayarlar bölümüne iki anahtar ekler.
(() => {
  const GUARD_DEFAULTS = { guardTyping: true, guardMedia: true };
  const ROWS = [
    ["guardTyping", "guard_typingLabel", "guard_typingHint"],
    ["guardMedia", "guard_mediaLabel", "guard_mediaHint"]
  ];

  function makeRow(id, labelKey, hintKey) {
    const row = document.createElement("label");
    row.className = "row";
    const text = document.createElement("span");
    const label = document.createElement("span");
    label.textContent = i18n(labelKey);
    const hint = document.createElement("small");
    hint.className = "hint";
    hint.textContent = i18n(hintKey);
    text.append(label, hint);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = id;
    box.className = "toggle";
    row.append(text, box);
    return { row, box };
  }

  RNP.init.push(async () => {
    const host = $("settingsProtect");
    if (!host) return;
    const s = await chrome.storage.sync.get(GUARD_DEFAULTS);
    const wrap = document.createElement("div");
    wrap.className = "guard-settings";
    for (const [id, labelKey, hintKey] of ROWS) {
      const { row, box } = makeRow(id, labelKey, hintKey);
      box.checked = s[id] !== false;
      box.addEventListener("change", async () => {
        await chrome.storage.sync.set({ [id]: box.checked });
        toast(i18n("settingsSaved"));
        refresh();
      });
      wrap.append(row);
    }
    host.append(wrap);
  });
})();

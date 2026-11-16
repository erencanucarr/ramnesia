function showSettings(open) {
  $("mainView").hidden = open;
  $("settingsView").hidden = !open;
  $("openSettings").classList.toggle("on", open);
  $("openSettings").setAttribute("aria-pressed", String(open));
  window.scrollTo(0, 0);
}
$("openSettings").addEventListener("click", () => showSettings($("settingsView").hidden));
$("closeSettings").addEventListener("click", () => showSettings(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("settingsView").hidden) {
    e.preventDefault();
    showSettings(false);
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  for (const h of RNP.init) {
    try { await h(); } catch (e) { console.warn("Ramnesia popup init error", e); }
  }
  refresh();
  setTimeout(refresh, 1500);
  setInterval(refresh, 5000);
});

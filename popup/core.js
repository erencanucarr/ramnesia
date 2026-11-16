const DEFAULTS = {
  enabled: true,
  minutes: 5,
  skipPinned: true,
  skipAudible: true,
  notify: false,
  whitelist: [],
  pressureMode: false,
  pressureThreshold: 85,
  pressureMinutes: 1,
  siteRules: []
};

const NUM_LIMITS = {
  minutes: [1, 240, DEFAULTS.minutes],
  pressureThreshold: [50, 95, DEFAULTS.pressureThreshold],
  pressureMinutes: [1, 60, DEFAULTS.pressureMinutes]
};

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const RNP = {
  afterStats: [],
  afterTabs: [],
  init: []
};
function runPopupHooks(list, ...args) {
  for (const h of list) {
    try { h(...args); } catch (e) { console.warn("Ramnesia popup hook error", e); }
  }
}

const i18n = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;
const UI_LANG = chrome.i18n.getUILanguage();
const DECIMAL_SEP = /^tr\b/i.test(UI_LANG) ? "," : ".";

function localizePage() {
  document.documentElement.lang = UI_LANG;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = i18n(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = i18n(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = i18n(el.dataset.i18nTitle);
  });
}
localizePage();

function fmtBytes(b) {
  const mb = b / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(1).replace(".", DECIMAL_SEP) + " GB";
  return Math.round(mb) + " MB";
}

const KIND_TITLE = {
  exact: "memExact",
  shared: "memShared",
  calibrated: "memCalibrated",
  heap: "memHeap",
  fallback: "memFallback"
};
const isApprox = (kind) => kind !== "exact";
const approxPrefix = (kind) => (isApprox(kind) ? "≈ " : "");
const kindTitle = (kind) => i18n(KIND_TITLE[kind] || "memHeap");
const awakeKind = (t) => t.memoryKind || "heap";
const savedKind = (s) => s.kind || (s.estimated ? "fallback" : "heap");

function setTileValue(el, text, approx) {
  const parts = [text];
  if (approx) parts.unshift(Object.assign(document.createElement("span"), { className: "approx", textContent: "≈ " }));
  el.replaceChildren(...parts);
  el.title = approx ? i18n("approxTitle") : "";
}

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

const ICONS = {
  lock: '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>'
};

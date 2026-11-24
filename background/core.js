const DEFAULTS = {
  enabled: true,
  minutes: 5,
  skipPinned: true,
  skipAudible: true,
  notify: false,
  whitelist: [],
  siteRules: [],
  pressureMode: false,
  pressureThreshold: 85,
  pressureMinutes: 1
};

const RN = {
  skipHooks: [],
  beforeBatch: [],
  afterBatch: [],
  statsExtras: [],
  tabExtras: [],
  messages: {},
  memoryProviders: []
};

async function runHooks(list, ...args) {
  for (const h of list) {
    try {
      await h(...args);
    } catch (e) {
      console.warn("Ramnesia hook error", e);
    }
  }
}

async function extraSkipReason(tab, s) {
  for (const h of RN.skipHooks) {
    try {
      const r = await h(tab, s);
      if (r) return r;
    } catch (e) {
      console.warn("Ramnesia skip hook error", e);
    }
  }
  return null;
}

const ALARM = "ramnesia-tick";
const CHECK_EVERY_MIN = 0.5;
const FALLBACK_BYTES = 50 * 1024 * 1024;
const MEM_TTL_ACTIVE_MS = 15 * 1000;
const MEM_TTL_BG_MS = 2 * 60 * 1000;
const MEASURE_CONCURRENCY = 6;
const MEASURE_TIMEOUT_MS = 800;
const MEM_PERSIST_DELAY_MS = 2000;
const TABSINFO_BUDGET_MS = 300;

const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

async function getSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  s.pressureThreshold = clampInt(s.pressureThreshold, 50, 95, DEFAULTS.pressureThreshold);
  s.pressureMinutes = clampInt(s.pressureMinutes, 1, 60, DEFAULTS.pressureMinutes);
  return s;
}

const i18n = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;
const DECIMAL_SEP = /^tr\b/i.test(chrome.i18n.getUILanguage()) ? "," : ".";
async function sget(key, def) {
  const r = await chrome.storage.session.get(key);
  return r[key] ?? def;
}
const sset = (obj) => chrome.storage.session.set(obj);

async function getTotals() {
  const { totals } = await chrome.storage.local.get("totals");
  return totals || { bytes: 0, count: 0, since: Date.now() };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isWhitelisted(url, whitelist) {
  const host = hostOf(url);
  if (!host) return false;
  return whitelist.some((d) => {
    d = d.trim().toLowerCase().replace(/^www\./, "");
    return d && (host === d || host.endsWith("." + d));
  });
}

const isWeb = (url) => !!url && /^https?:/.test(url);

function fmtBytes(b) {
  const mb = b / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(1).replace(".", DECIMAL_SEP) + " GB";
  return Math.round(mb) + " MB";
}

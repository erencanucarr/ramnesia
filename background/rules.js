function skipReason(tab, s) {
  if (s.skipPinned && tab.pinned) return "pinned";
  if (tab.autoDiscardable === false) return "locked";
  if (tab.active) return "active";
  if (s.skipAudible && tab.audible) return "audible";
  if (isWhitelisted(tab.url, s.whitelist)) return "whitelist";
  return null;
}

function canDiscard(tab, s) {
  if (tab.discarded || tab.frozen || tab.status === "loading") return false;
  if (!isWeb(tab.url)) return false;
  return skipReason(tab, s) === null;
}

async function effectiveLimit(s) {
  const usedPct = s.pressureMode ? await memUsedPct() : null;
  const pressureActive = !!s.pressureMode && usedPct != null && usedPct >= s.pressureThreshold;
  const minutes = pressureActive ? Math.min(s.minutes, s.pressureMinutes) : s.minutes;
  return { pressureActive, minutes, limitMs: minutes * 60 * 1000 };
}

function siteRuleFor(url, rules) {
  const host = hostOf(url);
  if (!host || !Array.isArray(rules)) return null;
  let best = null;
  for (const r of rules) {
    const d = String(r?.host || "").trim().toLowerCase().replace(/^www\./, "");
    const m = parseInt(r?.minutes, 10);
    if (!d || !(m >= 1)) continue;
    if ((host === d || host.endsWith("." + d)) && (!best || d.length > best.host.length)) {
      best = { host: d, minutes: Math.min(m, 1440) };
    }
  }
  return best;
}

function limitMsForTab(tab, s, eff) {
  const rule = siteRuleFor(tab.url, s.siteRules);
  if (!rule) return eff.limitMs;
  const minutes = eff.pressureActive ? Math.min(rule.minutes, s.pressureMinutes) : rule.minutes;
  return minutes * 60 * 1000;
}

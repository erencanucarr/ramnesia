Object.assign(DEFAULTS, {
  sleepOnLock: false,
  sleepOnIdle: false,
  idleMinutes: 10
});

const IDLE_MIN_GAP_MS = 60 * 1000;
const idleMinutesOf = (s) => clampInt(s.idleMinutes, 1, 120, DEFAULTS.idleMinutes);

async function applyIdleInterval() {
  try {
    const s = await getSettings();
    chrome.idle.setDetectionInterval(Math.max(15, idleMinutesOf(s) * 60));
  } catch (e) {
    console.warn("Ramnesia idle interval error", e);
  }
}

let idleQueue = Promise.resolve();

async function handleIdleState(state) {
  const st = await sget("idleAway", { away: false, swept: false, lastSweepAt: 0 });

  if (state === "active") {
    await sset({ idleAway: { away: false, swept: false, lastSweepAt: st.lastSweepAt } });
    return;
  }

  st.away = true;
  const s = await getSettings();
  const wanted = (state === "locked" && s.sleepOnLock) || (state === "idle" && s.sleepOnIdle);
  const now = Date.now();
  if (!s.enabled || !wanted || st.swept || now - (st.lastSweepAt || 0) < IDLE_MIN_GAP_MS) {
    await sset({ idleAway: st });
    return;
  }

  st.swept = true;
  st.lastSweepAt = now;
  await sset({ idleAway: st });

  const { count, bytes } = await sweep({ force: true, source: "idle" });
  if (count > 0) await sset({ idleLast: { at: now, count, bytes, state } });
}

chrome.idle.onStateChanged.addListener((state) => {
  idleQueue = idleQueue
    .then(() => handleIdleState(state))
    .catch((e) => console.warn("Ramnesia idle error", e));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.idleMinutes) applyIdleInterval();
});

RN.statsExtras.push(async () => ({ idleLast: await sget("idleLast", null) }));

applyIdleInterval();

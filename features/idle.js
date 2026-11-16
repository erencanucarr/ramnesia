// Ramnesia feature: idle (background). See RN hooks in background.js.
// Bilgisayar kilitlenince / kullanıcı uzaktayken arka plandaki sekmeleri uyutur.
// sweep({ force: true }) süreyi atlar ama tüm korumalar (etkin sekme, kilitli,
// sabitlenmiş/ses çalan, beyaz liste, diğer özelliklerin skipHooks'u) geçerlidir.

Object.assign(DEFAULTS, {
  sleepOnLock: false, // ekran kilitlenince uyut (isteğe bağlı)
  sleepOnIdle: false, // kullanıcı boşta kalınca uyut (isteğe bağlı)
  idleMinutes: 10     // chrome.idle algılama aralığı (1–120 dk)
});

const IDLE_MIN_GAP_MS = 60 * 1000; // iki uzakta-uyutma arasında en az 60 sn
const idleMinutesOf = (s) => clampInt(s.idleMinutes, 1, 120, DEFAULTS.idleMinutes);

async function applyIdleInterval() {
  try {
    const s = await getSettings();
    // Chrome en az 15 sn kabul eder; 1 dk = 60 sn olduğu için zaten üstünde
    chrome.idle.setDetectionInterval(Math.max(15, idleMinutesOf(s) * 60));
  } catch (e) {
    console.warn("Ramnesia idle interval error", e);
  }
}

// Olaylar art arda gelebilir (ör. idle → locked); işlemleri sıraya diz ki
// iki olay aynı anda depolamayı okuyup ikisi birden uyutmasın.
let idleQueue = Promise.resolve();

async function handleIdleState(state) {
  // idleAway: { away: bool, swept: bool, lastSweepAt: number }
  const st = await sget("idleAway", { away: false, swept: false, lastSweepAt: 0 });

  if (state === "active") {
    // uzakta dönemi bitti → bir sonraki uzaklaşmada yeniden uyutulabilir
    await sset({ idleAway: { away: false, swept: false, lastSweepAt: st.lastSweepAt } });
    return;
  }

  // "locked" ya da "idle": aynı uzakta dönemindeyiz
  st.away = true;
  const s = await getSettings();
  const wanted = (state === "locked" && s.sleepOnLock) || (state === "idle" && s.sleepOnIdle);
  const now = Date.now();
  // locked→idle→locked gibi geçişlerde dönem başına tek uyutma + en az 60 sn ara
  if (!s.enabled || !wanted || st.swept || now - (st.lastSweepAt || 0) < IDLE_MIN_GAP_MS) {
    await sset({ idleAway: st });
    return;
  }

  // önce "uyuttum" diye işaretle, sonra uyut (servis çalışanı yarıda kalsa da tekrar etmez)
  st.swept = true;
  st.lastSweepAt = now;
  await sset({ idleAway: st });

  // bildirim (notify açıksa) sweep içinde zaten gösterilir
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

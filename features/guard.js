// Ramnesia feature: guard (background).
// Yazı yazılan (kaydedilmemiş girdi) veya görüşme/ekran paylaşımı yapılan sekmeleri korur.
// Durum içerik betiklerinden "guardState" mesajıyla gelir; sekme + çerçeve bazında
// chrome.storage.session'da tutulur ve sekme düzeyinde birleştirilir (herhangi bir çerçeve = sekme).

Object.assign(DEFAULTS, {
  guardTyping: true, // yazı yazılan sekmeleri uyutma
  guardMedia: true   // kamera/mikrofon/ekran paylaşımı açık sekmeleri uyutma
});

(() => {
  const KEY = "guard"; // session: { [tabId]: { [frameId]: { typing, media, doc } } }
  const SCRIPTS = { main: "features/guard.main.js", isolated: "features/guard.content.js" };

  let mirrorP = null;              // storage.session'ın bellek kopyası (SW yeniden başlayınca tekrar okunur)
  let queue = Promise.resolve();   // okuma-değiştirme-yazma işlemlerini sıraya koyar

  // Söz (promise) saklanır: soğuk başlangıçta aynı anda gelen çağrılar aynı nesneyi alır.
  function load() {
    return (mirrorP ??= sget(KEY, {}));
  }

  // fn(all) true dönerse değişiklik kaydedilir.
  function mutate(fn) {
    const run = queue.then(async () => {
      const all = await load();
      if (fn(all)) await sset({ [KEY]: all });
    });
    queue = run.catch((e) => console.warn("Ramnesia guard", e));
    return queue;
  }

  async function tabState(tabId) {
    await queue;
    const frames = (await load())[tabId];
    const r = { typing: false, media: false };
    if (frames) {
      for (const f of Object.values(frames)) {
        if (f.typing) r.typing = true;
        if (f.media) r.media = true;
      }
    }
    return r;
  }

  const clearTab = (tabId) =>
    mutate((all) => {
      if (!(tabId in all)) return false;
      delete all[tabId];
      return true;
    });

  const ping = (tabId) => chrome.tabs.sendMessage(tabId, { type: "guardPing" }).catch(() => {});

  // --- içerik betiklerinden gelen durum --------------------------------------

  RN.messages.guardState = async (msg, sender) => {
    const tabId = sender?.tab?.id;
    if (sender?.id !== chrome.runtime.id || tabId == null || tabId < 0) return { ok: false };
    const frameId = String(sender.frameId ?? 0);
    const doc = sender.documentId || null;
    const typing = msg.typing === true;
    const media = msg.media === true;
    await mutate((all) => {
      const frames = all[tabId] || {};
      const cur = frames[frameId];
      if (typing || media) {
        if (cur && cur.typing === typing && cur.media === media && cur.doc === doc) return false;
        frames[frameId] = { typing, media, doc };
      } else {
        if (!cur) return false;
        // aynı çerçevede yeni belge yüklendiyse eski belgenin geç gelen "temiz" mesajını yok say
        if (cur.doc && doc && cur.doc !== doc) return false;
        delete frames[frameId];
      }
      if (Object.keys(frames).length) all[tabId] = frames;
      else delete all[tabId];
      return true;
    });
    return { ok: true };
  };

  // --- temizlik -------------------------------------------------------------

  chrome.tabs.onRemoved.addListener((tabId) => {
    clearTab(tabId);
  });

  chrome.tabs.onReplaced.addListener((_added, removed) => {
    clearTab(removed);
  });

  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.discarded === true) {
      clearTab(tabId);
    } else if (info.status === "loading" && info.url) {
      // Üst çerçevede URL değişti: eski durumu sil. SPA gezinmesinde (belge aynı kalır)
      // içerik betikleri hâlâ çalıştığı için durumlarını yeniden bildirmelerini iste.
      clearTab(tabId).then(() => ping(tabId));
    }
  });

  // Servis çalışanı her başladığında artık olmayan sekmelerin kayıtlarını at.
  chrome.tabs
    .query({})
    .then((tabs) => {
      const alive = new Set(tabs.map((t) => String(t.id)));
      return mutate((all) => {
        let changed = false;
        for (const id of Object.keys(all)) {
          if (!alive.has(id)) {
            delete all[id];
            changed = true;
          }
        }
        return changed;
      });
    })
    .catch(() => {});

  // --- uyutma kancaları ------------------------------------------------------

  RN.skipHooks.push(async (tab, s) => {
    if (!s.guardTyping && !s.guardMedia) return null;
    const st = await tabState(tab.id);
    if (s.guardMedia && st.media) return "media";
    if (s.guardTyping && st.typing) return "typing";
    return null;
  });

  RN.tabExtras.push(async (tab) => ({ guard: await tabState(tab.id) }));

  // --- kurulum/güncelleme: açık sekmelere betikleri enjekte et ------------------
  // Manifestteki content_scripts yalnızca bundan sonra yüklenen sayfalara girer.

  chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason !== "install" && reason !== "update") return;
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    } catch {
      return;
    }
    await Promise.allSettled(
      tabs
        .filter((t) => !t.discarded && !t.frozen)
        .map(async (t) => {
          const target = { tabId: t.id, allFrames: true };
          try {
            await chrome.scripting.executeScript({ target, files: [SCRIPTS.main], world: "MAIN", injectImmediately: true });
          } catch {}
          try {
            await chrome.scripting.executeScript({ target, files: [SCRIPTS.isolated], injectImmediately: true });
          } catch {}
        })
    );
  });
})();

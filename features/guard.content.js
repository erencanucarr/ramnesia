// Ramnesia guard: isolated-world content script.
// - Kaydedilmemiş kullanıcı girdisini (yazı) algılar.
// - guard.main.js'ten (MAIN world) gelen görüşme/ekran paylaşımı durumunu alır.
// Durum değişince arka plana { type: "guardState", typing, media } gönderir.
(() => {
  const NS = "__ramnesiaGuardIsolated";
  const MSG = "__ramnesiaGuard";

  // Aynı dünyada geçerli bir kopya zaten çalışıyorsa çık; bağlamı kopmuş eski kopyayı durdur.
  const prev = globalThis[NS];
  try {
    if (prev && prev.alive()) return;
    if (prev) prev.stop();
  } catch {}

  const EVAL_DELAY = 400;   // yazma durunca değerlendir (debounce)
  const RECHECK_MS = 5000;  // kirli alan varken programatik temizlemeyi/silinmeyi yakala
  const TEXT_TYPES = new Set(["text", "email", "url", "tel", "number", "password"]);

  const baseline = new WeakMap(); // alan -> odaklanınca/ilk görülünce değeri
  const dirty = new Set();
  const pending = new Set();
  const bound = [];
  let media = false;
  let sent = "false|false"; // arka plana son bildirilen durum (başlangıç = temiz)
  let evalTimer = 0;
  let recheckTimer = 0;
  let dead = false;

  function alive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function on(target, type, fn) {
    target.addEventListener(type, fn, true);
    bound.push([target, type, fn]);
  }

  function stop() {
    dead = true;
    for (const [t, type, fn] of bound) {
      try { t.removeEventListener(type, fn, true); } catch {}
    }
    bound.length = 0;
    clearTimeout(evalTimer);
    clearInterval(recheckTimer);
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch {}
  }

  // --- alan tespiti ----------------------------------------------------------

  const realTarget = (e) => {
    try {
      return (e.composedPath && e.composedPath()[0]) || e.target;
    } catch {
      return e.target;
    }
  };

  function fieldOf(node) {
    if (node && node.nodeType === 3) node = node.parentElement;
    if (!node || node.nodeType !== 1) return null;
    const tag = node.localName;
    if (tag === "textarea" || tag === "select") return node;
    if (tag === "input") return TEXT_TYPES.has(node.type) ? node : null; // type=search hariç
    if (node.isContentEditable) {
      let host = node;
      while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
      return host;
    }
    return null;
  }

  // Arama kutuları "kaydedilmemiş yazı" sayılmaz.
  function ignored(el) {
    try {
      if ((el.getAttribute("role") || "").toLowerCase() === "searchbox") return true;
      if (el.closest('[role="search" i], search')) return true;
      if ((el.localName === "input" || el.localName === "textarea") && /^(q|query|search)$/i.test(el.name || ""))
        return true;
    } catch {}
    return false;
  }

  function valueOf(el) {
    if (el.localName === "select") return Array.from(el.options, (o) => (o.selected ? "1" : "0")).join("");
    if (el.localName === "input" || el.localName === "textarea") return el.value;
    return el.textContent || "";
  }

  function defaultOf(el) {
    if (el.localName === "select") {
      const opts = Array.from(el.options);
      const anyDefault = opts.some((o) => o.defaultSelected);
      return opts
        .map((o, i) => (o.defaultSelected || (!anyDefault && !el.multiple && i === 0) ? "1" : "0"))
        .join("");
    }
    if (el.localName === "input" || el.localName === "textarea") return el.defaultValue;
    return ""; // contenteditable: başlangıç bilinmiyorsa boş say
  }

  const blank = (v) => /^[\s​-‍﻿]*$/.test(v);

  function isDirty(el) {
    if (!el.isConnected) return false;
    const v = valueOf(el);
    if (el.localName !== "select" && blank(v)) return false;
    const base = baseline.has(el) ? baseline.get(el) : defaultOf(el);
    return v !== base;
  }

  // --- değerlendirme ve bildirim ----------------------------------------------

  function evaluate() {
    evalTimer = 0;
    if (dead) return;
    for (const el of pending) dirty.add(el);
    pending.clear();
    for (const el of dirty) {
      let d = false;
      try { d = isDirty(el); } catch {}
      if (!d) dirty.delete(el);
    }
    if (dirty.size && !recheckTimer) recheckTimer = setInterval(evaluate, RECHECK_MS);
    if (!dirty.size && recheckTimer) {
      clearInterval(recheckTimer);
      recheckTimer = 0;
    }
    report();
  }

  function scheduleEval() {
    clearTimeout(evalTimer);
    evalTimer = setTimeout(evaluate, EVAL_DELAY);
  }

  function send(typing, mediaOn) {
    try {
      const p = chrome.runtime.sendMessage({ type: "guardState", typing, media: mediaOn });
      if (p && typeof p.catch === "function")
        p.catch(() => {
          if (!alive()) stop();
          else sent = null; // bir sonraki değerlendirmede tekrar dene
        });
      return true;
    } catch {
      stop(); // "Extension context invalidated"
      return false;
    }
  }

  function report(force) {
    if (dead) return;
    if (!alive()) return stop();
    const typing = dirty.size > 0;
    const key = typing + "|" + media;
    if (!force && key === sent) return;
    sent = key;
    send(typing, media);
  }

  // --- olaylar --------------------------------------------------------------

  on(window, "focusin", (e) => {
    const el = fieldOf(realTarget(e));
    if (el && !baseline.has(el)) {
      try { baseline.set(el, valueOf(el)); } catch {}
    }
  });

  on(window, "input", (e) => {
    if (!e.isTrusted) return;
    const el = fieldOf(realTarget(e));
    if (!el || ignored(el)) return;
    if (!baseline.has(el)) {
      try { baseline.set(el, defaultOf(el)); } catch {}
    }
    pending.add(el);
    scheduleEval();
  });

  // Gönderilen formdaki alanlar artık "kaydedildi" sayılır.
  function settleForm(form) {
    if (!form || typeof form.contains !== "function") return;
    for (const el of [...dirty, ...pending]) {
      if (form.contains(el)) {
        try { baseline.set(el, valueOf(el)); } catch {}
        dirty.delete(el);
        pending.delete(el);
      }
    }
    try {
      for (const el of Array.from(form.elements || [])) {
        const f = fieldOf(el);
        if (f) baseline.set(f, valueOf(f));
      }
    } catch {}
    evaluate();
  }

  on(window, "submit", (e) => settleForm(realTarget(e)));
  on(window, "reset", (e) => {
    const form = realTarget(e);
    setTimeout(() => settleForm(form), 0); // değerler sıfırlandıktan sonra
  });

  // Sayfa gizlenince (gezinme/bfcache) arka plandaki durumu temizle; geri gelince yeniden bildir.
  on(window, "pagehide", () => {
    if (dead || !alive()) return;
    if (sent !== "false|false") send(false, false);
    sent = null;
  });
  on(window, "pageshow", (e) => {
    if (e.persisted) report(true);
  });

  // MAIN world'den gelen görüşme durumu
  on(window, "message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== "object" || d[MSG] !== 1 || d.kind !== "media" || typeof d.live !== "boolean") return;
    if (media !== d.live) {
      media = d.live;
      report();
    }
  });

  // Arka plan gezinmeden sonra durumu yeniden ister.
  function onRuntimeMessage(msg) {
    if (msg && msg.type === "guardPing") report(true);
  }
  try {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch {
    return;
  }

  // Sonradan enjekte edildiysek (eklenti kurulumu/güncellemesi) mevcut doldurulmuş alanları tara.
  if (document.readyState !== "loading") {
    try {
      for (const el of document.querySelectorAll("textarea, input")) {
        const f = fieldOf(el);
        if (f && !ignored(f) && f.value !== f.defaultValue) pending.add(f);
      }
      if (pending.size) scheduleEval();
    } catch {}
  }

  try {
    Object.defineProperty(globalThis, NS, { value: { alive, stop }, configurable: true, writable: true });
  } catch {}

  try {
    window.postMessage({ [MSG]: 1, kind: "query" }, "*");
  } catch {}
})();

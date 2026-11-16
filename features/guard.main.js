// Ramnesia guard: MAIN-world content script (page context).
// getUserMedia / getDisplayMedia ile alınan akışların izlerini (track) takip eder;
// "live" iz varken sayfa görüşmede/ekran paylaşımında sayılır. Durum, isolated
// dünyadaki guard.content.js'e window.postMessage ile bildirilir.
// Savunmacı yazıldı: sarmalama başarısız olursa sayfanın orijinal API'si aynen kalır.
(() => {
  const W = window;
  const KEY = Symbol.for("ramnesia.guard.main");
  const MSG = "__ramnesiaGuard";

  try {
    // Zaten kurulu (ör. eklenti güncellemesinden sonra yeniden enjekte edildi): sadece durumu duyur.
    if (typeof W[KEY] === "function") {
      W[KEY]();
      return;
    }
  } catch {
    return;
  }

  let post, setI, clearI;
  try {
    post = W.postMessage.bind(W);
    setI = W.setInterval.bind(W);
    clearI = W.clearInterval.bind(W);
  } catch {
    return;
  }

  const POLL_MS = 3000; // track.stop() "ended" olayı tetiklemez, bu yüzden hafifçe yokla
  const tracks = new Set();
  let live = false;
  let timer = 0;

  function announce() {
    try { post({ [MSG]: 1, kind: "media", live }, "*"); } catch {}
  }

  function check() {
    let any = false;
    for (const t of tracks) {
      let state;
      try { state = t.readyState; } catch {}
      if (state === "live") any = true;
      else tracks.delete(t);
    }
    if (!tracks.size && timer) {
      clearI(timer);
      timer = 0;
    }
    if (any !== live) {
      live = any;
      announce();
    }
  }

  function addTrack(t) {
    try {
      if (!t || tracks.has(t)) return;
      tracks.add(t);
      t.addEventListener("ended", check);
      if (!timer) timer = setI(check, POLL_MS);
    } catch {}
  }

  function addStream(s) {
    try {
      if (!s || typeof s.getTracks !== "function") return;
      s.getTracks().forEach(addTrack);
      s.addEventListener("addtrack", (e) => { addTrack(e.track); check(); });
      check();
    } catch {}
  }

  // proto[name] fonksiyonunu, özelliklerini koruyarak sarmalar.
  function wrap(proto, name, make) {
    try {
      const d = proto && Object.getOwnPropertyDescriptor(proto, name);
      if (!d || typeof d.value !== "function" || (!d.writable && !d.configurable)) return;
      const orig = d.value;
      const w = make(orig);
      try {
        Object.defineProperty(w, "name", { value: name, configurable: true });
        Object.defineProperty(w, "length", { value: orig.length, configurable: true });
      } catch {}
      Object.defineProperty(proto, name, { ...d, value: w });
    } catch {}
  }

  // Promise döndüren API'ler: aynı promise'i sayfaya geri ver, yan dalda izle.
  const viaPromise = (orig) =>
    function (...args) {
      const p = Reflect.apply(orig, this, args);
      try {
        if (p && typeof p.then === "function") p.then(addStream, () => {});
      } catch {}
      return p;
    };

  // Eski geri çağırımlı API: navigator.webkitGetUserMedia(constraints, success, error)
  const viaCallback = (orig) =>
    function (constraints, ok, err, ...rest) {
      const ok2 =
        typeof ok === "function"
          ? function (stream) {
              addStream(stream);
              return Reflect.apply(ok, this, arguments);
            }
          : ok;
      return Reflect.apply(orig, this, [constraints, ok2, err, ...rest]);
    };

  // Klonlanan izler/akışlar da aynı cihazı açık tutar.
  const viaClone = (orig, tracked) =>
    function (...args) {
      const r = Reflect.apply(orig, this, args);
      try { if (tracked(this)) (r && typeof r.getTracks === "function" ? addStream : addTrack)(r); } catch {}
      return r;
    };

  try {
    const MD = W.MediaDevices && W.MediaDevices.prototype;
    wrap(MD, "getUserMedia", viaPromise);
    wrap(MD, "getDisplayMedia", viaPromise);
    const NV = W.Navigator && W.Navigator.prototype;
    wrap(NV, "webkitGetUserMedia", viaCallback);
    wrap(NV, "getUserMedia", viaCallback);
    if (W.MediaStreamTrack) wrap(W.MediaStreamTrack.prototype, "clone", (o) => viaClone(o, (t) => tracks.has(t)));
    if (W.MediaStream)
      wrap(W.MediaStream.prototype, "clone", (o) => viaClone(o, (s) => s.getTracks().some((t) => tracks.has(t))));
  } catch {}

  // isolated betik yüklenince durumu sorar
  try {
    W.addEventListener("message", (e) => {
      try {
        if (e.source !== W) return;
        const d = e.data;
        if (d && typeof d === "object" && d[MSG] === 1 && d.kind === "query" && live) announce();
      } catch {}
    });
  } catch {}

  try {
    Object.defineProperty(W, KEY, { value: () => { if (live) announce(); } });
  } catch {}
})();

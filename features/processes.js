// Ramnesia feature: processes (background). See RN hooks in background.js.
//
// On Chrome Dev/Canary the chrome.processes API reports the real private memory of each
// renderer process. When it is available and the optional "processes" permission has been
// granted (from the popup, see processes.popup.js), this provider replaces the JS-heap /
// calibrated estimate with that real number. On Beta and Stable Chrome the API never exists, the
// provider returns null and the next provider (calibration, then raw heap) is used.
//
// Subframes: with site isolation, cross-site iframes run in their own renderer processes.
// Processes used only by this tab are added to its value; if one is shared with other
// tabs, the value is marked "shared" instead of "exact".
//
// Sharing: several tabs of the same site can live in one renderer process. Then the
// process's memory is split between its tabs (by JS heap when every tab's heap is known,
// evenly otherwise) and the result is marked kind "shared" (a real measurement, but split →
// the UI shows "≈"). kind "exact" only when the process belongs to this tab alone.
//
// Cost: collecting process memory costs CPU, so one snapshot (pid of every open tab + a
// single getProcessInfo(pids, true) call) is shared by all tabs for SNAP_MS. The popup
// refreshes every 5 s, so that's at most one memory collection per refresh.
(() => {
  const PERM = { permissions: ["processes"] };
  const SNAP_MS = 4000;

  const api = () => (typeof chrome !== "undefined" && chrome.processes) || null;

  // --- availability ----------------------------------------------------------
  // chrome.processes only exists once the permission is active, so "is this browser able
  // to use it at all" is answered by asking Chrome which install warnings a manifest with
  // just "processes" would get: on channels without the API the permission is dropped
  // (no warning), on Dev/Canary it maps to the "Read your browsing history" warning.
  // management.getPermissionWarningsByManifest needs no permission.
  let probe = null;
  function probeSupported() {
    if (api()) return Promise.resolve(true);
    if (!probe) {
      probe = (async () => {
        try {
          const fn = chrome.management?.getPermissionWarningsByManifest;
          if (!fn) return false;
          const manifest = JSON.stringify({
            name: "probe",
            version: "1.0",
            manifest_version: 3,
            permissions: ["processes"]
          });
          const warnings = await chrome.management.getPermissionWarningsByManifest(manifest);
          return Array.isArray(warnings) && warnings.length > 0;
        } catch {
          return false;
        }
      })();
    }
    return probe;
  }

  async function isGranted() {
    try {
      return !!(await chrome.permissions.contains(PERM));
    } catch {
      return false;
    }
  }

  // The "processes" permission is not declared in the shipped manifest (it shows a warning
  // on Stable/Beta). Chrome Dev users can add it to "optional_permissions" themselves; only
  // then is the option offered.
  function declared() {
    try {
      const m = chrome.runtime.getManifest();
      return [...(m.permissions || []), ...(m.optional_permissions || [])].includes("processes");
    } catch {
      return false;
    }
  }

  async function status() {
    if (!declared() && !api()) return { supported: false, granted: false };
    const [supported, granted] = await Promise.all([probeSupported(), isGranted()]);
    return { supported: supported || !!api(), granted: granted && (supported || !!api()) };
  }

  // --- snapshot ----------------------------------------------------------------
  // { t, pidByTab: Map<tabId, pid>, procs: { [pid]: Process } }
  let snap = null;
  let building = null;

  const validPid = (p) => Number.isInteger(p) && p > 0;

  async function pidOf(tabId) {
    try {
      const p = await api().getProcessIdForTab(tabId);
      return validPid(p) ? p : null;
    } catch {
      return null; // discarded / closed / no renderer yet
    }
  }

  async function processInfo(pids) {
    if (!pids.length) return {};
    const r = await api().getProcessInfo(pids, true);
    return r && typeof r === "object" ? r : {};
  }

  async function buildSnapshot() {
    const tabs = (await chrome.tabs.query({})).filter((t) => !t.discarded);
    const pidByTab = new Map();
    await Promise.all(
      tabs.map(async (t) => {
        const p = await pidOf(t.id);
        if (p) pidByTab.set(t.id, p);
      })
    );
    // Boş liste = tüm süreçler. Böylece sekmenin başka süreçlerdeki iframe'leri de görülür.
    const procs = pidByTab.size ? await processInfo([]) : {};
    return { t: Date.now(), pidByTab, procs };
  }

  async function getSnapshot() {
    if (snap && Date.now() - snap.t < SNAP_MS) return snap;
    if (!building) {
      building = buildSnapshot()
        .then((s) => (snap = s))
        .finally(() => (building = null));
    }
    return building;
  }

  // A tab opened after the snapshot was taken: look it up on its own and merge it in.
  async function ensureTab(s, tabId) {
    let pid = s.pidByTab.get(tabId);
    if (!pid) {
      pid = await pidOf(tabId);
      if (!pid) return null;
      s.pidByTab.set(tabId, pid);
    }
    if (!s.procs[pid]) Object.assign(s.procs, await processInfo([pid]));
    return pid;
  }

  const forget = () => {
    snap = null;
  };
  chrome.permissions?.onAdded?.addListener(forget);
  chrome.permissions?.onRemoved?.addListener(forget);
  chrome.tabs.onRemoved.addListener((tabId) => heapSeen.delete(tabId));

  // --- split -------------------------------------------------------------------

  // JS heaps seen by this provider (in memory: measureTab's memCache is written by
  // parallel read-modify-writes and can miss tabs), with memCache as a fallback.
  const heapSeen = new Map();
  async function cachedHeaps() {
    try {
      return (await chrome.storage.session.get("memCache")).memCache || {};
    } catch {
      return {};
    }
  }

  // Share of process `pid` that belongs to `tabId` (0..1) and how many tabs share it.
  async function shareOf(s, pid, tabId, heapBytes) {
    const proc = s.procs[pid];
    const tenants = new Set();
    for (const task of proc?.tasks || []) {
      if (Number.isInteger(task?.tabId) && task.tabId >= 0) tenants.add(task.tabId);
    }
    for (const [t, p] of s.pidByTab) if (p === pid) tenants.add(t);
    tenants.add(tabId);
    const n = tenants.size;
    if (n === 1) return { share: 1, n };

    // Proportional to JS heap only when every tenant's main frame lives in this process
    // and its heap is known; a tab that only has an iframe here says nothing by its heap.
    let heaps = null;
    let sum = 0;
    let mine = 0;
    for (const t of tenants) {
      let h = t === tabId && heapBytes > 0 ? heapBytes : heapSeen.get(t);
      if (!(h > 0)) h = (heaps ??= await cachedHeaps())[t]?.bytes;
      if (s.pidByTab.get(t) !== pid || !(h > 0)) return { share: 1 / n, n };
      sum += h;
      if (t === tabId) mine = h;
    }
    return { share: sum > 0 ? mine / sum : 1 / n, n };
  }

  // Sekmenin ana süreci dışındaki süreçler (site izolasyonu: başka sitelerin iframe'leri).
  // Sadece bu sekmeye ait olanların belleği eklenir; başka sekmelerle paylaşılan varsa
  // değer artık kesin sayılmaz (mixed → "shared").
  function subframeExtra(s, pid, tabId) {
    let extra = 0;
    let mixed = false;
    for (const [p, proc] of Object.entries(s.procs)) {
      if (Number(p) === pid || proc?.type !== "renderer") continue;
      const ids = new Set();
      for (const task of proc.tasks || []) {
        if (Number.isInteger(task?.tabId) && task.tabId >= 0) ids.add(task.tabId);
      }
      if (!ids.has(tabId)) continue;
      if (ids.size === 1 && proc.privateMemory > 0) extra += proc.privateMemory;
      else mixed = true;
    }
    return { extra, mixed };
  }

  async function provide(tab, heapBytes) {
    if (!api() || tab?.discarded || !Number.isInteger(tab?.id)) return null;
    if (heapBytes > 0) heapSeen.set(tab.id, heapBytes);
    try {
      const s = await getSnapshot();
      const pid = await ensureTab(s, tab.id);
      const mem = pid ? s.procs[pid]?.privateMemory : null;
      if (!(mem > 0)) return null;
      const { share, n } = await shareOf(s, pid, tab.id, heapBytes);
      const { extra, mixed } = subframeExtra(s, pid, tab.id);
      const bytes = Math.round(mem * share) + extra;
      if (!(bytes > 0)) return null;
      // "shared": real process memory, split between n tabs → shown with "≈".
      return n === 1 && !mixed ? { bytes, kind: "exact" } : { bytes, kind: "shared", sharedWith: n };
    } catch (e) {
      console.debug("Ramnesia processes provider failed", e);
      return null;
    }
  }

  RN.memoryProviders.push({ priority: 10, fn: provide });

  RN.statsExtras.push(async () => ({ processes: await status() }));

  RN.messages.processesStatus = () => status();
})();

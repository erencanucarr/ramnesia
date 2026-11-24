importScripts(
  "background/core.js",
  "background/memory.js",
  "background/rules.js",
  "background/discard.js",
  "background/events.js",
  "background/messages.js"
);

ensureAlarm();
updateBadge();

importScripts(
  "features/guard.js",
  "features/idle.js",
  "features/groups.js",
  "features/realgain.js",
  "features/calibrate.js",
  "features/processes.js",
  "features/menu.js",
  "features/pinned.js"
);

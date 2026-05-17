// localStorage persistence for in-progress matches.
// Snapshot shape: { version, mode, state, ui }
// On schema change, bump VERSION and old snapshots will be ignored.

const KEY = "benny:match:v1";
const PREFS_KEY = "benny:prefs:v1";
const VERSION = 1;

function safeStorage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

export function loadPrefs() {
  const ls = safeStorage();
  if (!ls) return {};
  try {
    const raw = ls.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch (_) { return {}; }
}

export function savePrefs(prefs) {
  const ls = safeStorage();
  if (!ls) return;
  try { ls.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
}

export function save(snapshot) {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.setItem(KEY, JSON.stringify({ version: VERSION, savedAt: Date.now(), ...snapshot }));
  } catch (_) {
    // Quota or private-mode failure — silently drop. The match still works in memory.
  }
}

export function load() {
  const ls = safeStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== VERSION) return null;
    return obj;
  } catch (_) {
    return null;
  }
}

export function clear() {
  const ls = safeStorage();
  if (!ls) return;
  try { ls.removeItem(KEY); } catch (_) {}
}

export function hasSnapshot() {
  return !!load();
}

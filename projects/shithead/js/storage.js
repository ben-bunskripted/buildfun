// localStorage persistence: one resumable match slot per local mode, plus a
// preferences blob that outlives matches. Mirrors Benny's storage shape.

const KEY_PREFIX = "shithead:match:v1:";
const PREFS_KEY = "shithead:prefs:v1";
const VERSION = 1;
export const MATCH_MODES = ["cpu", "local"];

function safeStorage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}
function keyFor(mode) { return KEY_PREFIX + mode; }

export function loadPrefs() {
  const ls = safeStorage();
  if (!ls) return {};
  try { const raw = ls.getItem(PREFS_KEY); return raw ? (JSON.parse(raw) || {}) : {}; }
  catch (_) { return {}; }
}

export function savePrefs(prefs) {
  const ls = safeStorage();
  if (!ls) return;
  try { ls.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
}

export function save(snapshot) {
  const ls = safeStorage();
  if (!ls) return;
  const mode = snapshot && snapshot.mode;
  if (!MATCH_MODES.includes(mode)) return;
  try {
    ls.setItem(keyFor(mode), JSON.stringify({ version: VERSION, savedAt: Date.now(), ...snapshot }));
  } catch (_) {}
}

export function load(mode) {
  const ls = safeStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(keyFor(mode));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== VERSION) return null;
    return obj;
  } catch (_) { return null; }
}

export function clear(mode) {
  const ls = safeStorage();
  if (!ls) return;
  try { ls.removeItem(keyFor(mode)); } catch (_) {}
}

export function hasSnapshot(mode) { return !!load(mode); }

export function loadAll() {
  const out = {};
  for (const m of MATCH_MODES) { const s = load(m); if (s) out[m] = s; }
  return out;
}

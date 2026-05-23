// localStorage persistence for in-progress matches.
//
// Each mode (multiplayer / cpu / scoring) gets its own slot so they can be
// resumed independently — starting a scoring game no longer clobbers a saved
// solo game. Snapshot shape per slot: { version, savedAt, mode, state, ui }.
// On schema change, bump VERSION and old snapshots will be ignored.

const KEY_PREFIX = "benny:match:v1:";
const LEGACY_KEY = "benny:match:v1"; // pre-per-mode single slot
const PREFS_KEY = "benny:prefs:v1";
const VERSION = 1;
export const MATCH_MODES = ["multiplayer", "cpu", "scoring"];

function safeStorage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

function keyFor(mode) { return KEY_PREFIX + mode; }

// One-time migration: fold a pre-per-mode snapshot into its mode slot.
function migrateLegacy(ls) {
  let raw;
  try { raw = ls.getItem(LEGACY_KEY); } catch (_) { return; }
  if (!raw) return;
  try {
    const obj = JSON.parse(raw);
    const mode = obj && obj.state && obj.state.mode;
    if (mode && MATCH_MODES.includes(mode) && !ls.getItem(keyFor(mode))) {
      ls.setItem(keyFor(mode), raw);
    }
  } catch (_) { /* drop unparseable legacy blob */ }
  try { ls.removeItem(LEGACY_KEY); } catch (_) {}
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

// Snapshot must carry a `mode` — it selects the slot.
export function save(snapshot) {
  const ls = safeStorage();
  if (!ls) return;
  const mode = snapshot && snapshot.mode;
  if (!MATCH_MODES.includes(mode)) return;
  try {
    ls.setItem(keyFor(mode), JSON.stringify({ version: VERSION, savedAt: Date.now(), ...snapshot }));
  } catch (_) {
    // Quota or private-mode failure — silently drop. The match still works in memory.
  }
}

export function load(mode) {
  const ls = safeStorage();
  if (!ls) return null;
  migrateLegacy(ls);
  try {
    const raw = ls.getItem(keyFor(mode));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== VERSION) return null;
    return obj;
  } catch (_) {
    return null;
  }
}

export function clear(mode) {
  const ls = safeStorage();
  if (!ls) return;
  try { ls.removeItem(keyFor(mode)); } catch (_) {}
}

export function hasSnapshot(mode) {
  return !!load(mode);
}

// All saved snapshots keyed by mode — used to decide which mode to land on at
// boot and to flag which modes have a resumable game.
export function loadAll() {
  const ls = safeStorage();
  if (!ls) return {};
  migrateLegacy(ls);
  const out = {};
  for (const m of MATCH_MODES) {
    const snap = load(m);
    if (snap) out[m] = snap;
  }
  return out;
}

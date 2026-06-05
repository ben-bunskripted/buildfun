// Persistent per-player profiles: lifetime stats + recent match history, keyed by
// lowercased name so casing variants share a record.

const KEY = "shithead:players:v1";
const MAX_HISTORY = 25;

function safeStorage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}
function readAll() {
  const ls = safeStorage();
  if (!ls) return {};
  try { return JSON.parse(ls.getItem(KEY) || "{}") || {}; } catch (_) { return {}; }
}
function writeAll(obj) {
  const ls = safeStorage();
  if (!ls) return;
  try { ls.setItem(KEY, JSON.stringify(obj)); } catch (_) {}
}
function keyFor(name) { return String(name || "").trim().toLowerCase(); }

export function getProfile(name) {
  const all = readAll();
  const k = keyFor(name);
  return all[k] || { name, stats: emptyStats(), achievements: [], history: [] };
}

function emptyStats() {
  return { games: 0, wins: 0, shitheads: 0, podiums: 0, bestPlace: null, currentStreak: 0, bestStreak: 0 };
}

// Record one finished match for one player. `place` is 1-based finish order;
// `isShithead` flags the loser; `total` is the player count.
export function recordMatch(name, { place, isShithead, total, mode }) {
  const all = readAll();
  const k = keyFor(name);
  const prof = all[k] || { name, stats: emptyStats(), achievements: [], history: [] };
  const s = prof.stats;
  s.games += 1;
  if (place === 1) s.wins += 1;
  if (isShithead) s.shitheads += 1;
  if (place && place <= Math.min(3, total - 1)) s.podiums += 1;
  s.bestPlace = s.bestPlace == null ? place : Math.min(s.bestPlace, place);
  if (place === 1) { s.currentStreak += 1; s.bestStreak = Math.max(s.bestStreak, s.currentStreak); }
  else s.currentStreak = 0;
  prof.history.unshift({ at: Date.now(), place, isShithead, total, mode });
  prof.history = prof.history.slice(0, MAX_HISTORY);
  prof.name = name; // keep latest casing
  all[k] = prof;
  writeAll(all);
  return prof;
}

export function addAchievements(name, ids) {
  if (!ids || !ids.length) return [];
  const all = readAll();
  const k = keyFor(name);
  const prof = all[k] || { name, stats: emptyStats(), achievements: [], history: [] };
  const have = new Set(prof.achievements);
  const fresh = ids.filter((id) => !have.has(id));
  prof.achievements = [...prof.achievements, ...fresh];
  all[k] = prof;
  writeAll(all);
  return fresh;
}

export function listProfiles() {
  return Object.values(readAll()).sort((a, b) => (b.stats.wins - a.stats.wins) || (a.stats.shitheads - b.stats.shitheads));
}

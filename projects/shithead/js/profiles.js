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
  return withDefaults(all[k]) || { name, stats: emptyStats(), achievements: [], history: [], progress: emptyProgress() };
}

function emptyStats() {
  return { games: 0, wins: 0, shitheads: 0, podiums: 0, bestPlace: null, currentStreak: 0, bestStreak: 0 };
}
// Lifetime tallies that accumulate across matches — drive the progress (bar)
// achievements. Older saved profiles predate this, so withDefaults() backfills.
function emptyProgress() {
  return { burns: 0, fourKinds: 0, jokers: 0, deflects: 0, twos: 0, tens: 0, pickups: 0, blindWins: 0 };
}
function withDefaults(prof) {
  if (!prof) return prof;
  if (!prof.progress) prof.progress = emptyProgress();
  if (!prof.history) prof.history = [];
  return prof;
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
  const prof = all[k] || { name, stats: emptyStats(), achievements: [], history: [], progress: emptyProgress() };
  const have = new Set(prof.achievements);
  const fresh = ids.filter((id) => !have.has(id));
  prof.achievements = [...prof.achievements, ...fresh];
  all[k] = prof;
  writeAll(all);
  return fresh;
}

// Fold one finished match's tallies into the player's lifetime progress counters.
export function accrueProgress(name, summary) {
  const all = readAll();
  const k = keyFor(name);
  const prof = withDefaults(all[k]) || { name, stats: emptyStats(), achievements: [], history: [], progress: emptyProgress() };
  const p = prof.progress;
  p.burns += summary.burns || 0;
  p.fourKinds += summary.fourKinds || 0;
  p.jokers += summary.jokers || 0;
  p.deflects += summary.deflects || 0;
  p.twos += summary.twos || 0;
  p.tens += summary.tens || 0;
  p.pickups += summary.pickups || 0;
  if (summary.place === 1 && summary.wonOnBlind) p.blindWins += 1;
  prof.name = name;
  all[k] = prof;
  writeAll(all);
  return prof;
}

export function listProfiles() {
  return Object.values(readAll()).map(withDefaults)
    .sort((a, b) => (b.stats.wins - a.stats.wins) || (a.stats.shitheads - b.stats.shitheads));
}

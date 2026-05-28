// Persistent per-player profiles: lifetime stats, match history, achievements.
// Profiles are keyed by name.trim().toLowerCase() so "Ben", "ben " and "BEN"
// all land on the same record. Display uses the first-seen casing.
//
// Storage key `benny:players:v1` is intentionally separate from
// `benny:match:v1` (in storage.js) — profiles outlive any single match.

import {
  ACHIEVEMENTS, PROGRESS_ACHIEVEMENTS, evaluateMatch,
  summariseSetsPerPlayer, RUN_TARGET,
} from "./achievements.js";

const KEY = "benny:players:v1";
const VERSION = 1;
const HISTORY_CAP = 50;

function safeStorage() {
  try { return globalThis.localStorage || null; } catch (_) { return null; }
}

function emptyProfiles() {
  return { version: VERSION, players: {} };
}

export function loadProfiles() {
  const ls = safeStorage();
  if (!ls) return emptyProfiles();
  try {
    const raw = ls.getItem(KEY);
    if (!raw) return emptyProfiles();
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== VERSION || !obj.players) return emptyProfiles();
    return obj;
  } catch (_) { return emptyProfiles(); }
}

export function saveProfiles(profiles) {
  const ls = safeStorage();
  if (!ls) return;
  try { ls.setItem(KEY, JSON.stringify(profiles)); } catch (_) {}
}

export function keyFor(name) {
  return String(name || "").trim().toLowerCase();
}

export function ensureProfile(profiles, name) {
  const k = keyFor(name);
  if (!k) return null;
  let p = profiles.players[k];
  if (!p) {
    p = {
      canonical: String(name).trim(),
      aliases: [String(name).trim()],
      stats: {
        matchesPlayed: 0, matchesWon: 0,
        totalScore: 0, bestMatch: null, worstMatch: null,
        roundsPlayed: 0, roundsWon: 0,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      },
      achievements: [],
      matchHistory: [],
      // Per-mode lifetime progress: { [mode]: { [achievementId]: {value, items} } }
      progress: {},
    };
    profiles.players[k] = p;
  } else {
    const alias = String(name).trim();
    if (alias && !p.aliases.includes(alias)) p.aliases.push(alias);
  }
  return p;
}

export function listKnownPlayers(profiles) {
  return Object.values(profiles.players)
    .slice()
    .sort((a, b) => (b.stats.lastSeen || "").localeCompare(a.stats.lastSeen || ""));
}

// Build a per-player summary from a finalised match state. Used both as the
// achievement evaluator's input and as what gets folded into each profile.
//
// Position is 1-based, lowest score = 1st. Ties resolve by playing index so
// the result is deterministic.
export function buildMatchSummary(state) {
  const players = state.players.map((p, i) => ({ idx: i, name: p.name, score: p.score }));
  const sortedByScore = players.slice().sort((a, b) => a.score - b.score || a.idx - b.idx);
  const positionByIdx = {};
  sortedByScore.forEach((p, rank) => { positionByIdx[p.idx] = rank + 1; });

  const roundHistory = Array.isArray(state.roundHistory) ? state.roundHistory : [];
  const matchEvents = state.matchEvents || { opens: [], discards: [], rounds: [] };

  return {
    mode: state.mode,
    date: new Date().toISOString(),
    totalPlayers: state.players.length,
    players: state.players.map((p, i) => ({
      idx: i,
      name: p.name,
      kind: p.kind || "human",     // scoring mode players have no kind — treat as human
      finalScore: p.score,
      position: positionByIdx[i],
      isWinner: positionByIdx[i] === 1,
      isDealer: i === state.dealerIndex,
      roundsWon: roundHistory.filter(r => r.winnerIdx === i).length,
    })),
    roundHistory,
    matchEvents,
    dealerIndex: state.dealerIndex,
    // Per-match option — gates the "wild label off" achievements.
    hideWildLabel: !!(state.options && state.options.hideWildLabel),
  };
}

// Apply a match summary to the profiles store. Returns
//   newUnlocks         — one-shot achievement IDs earned for the first time.
//   progressUnlocks    — progress achievement IDs whose bar just hit target.
//   progressGains      — every progress achievement that gained ground, with
//                        before/after values and which items are new.
// All three are keyed by playerIdx, so the match-end screen can render the
// "Rewards earned" section + a section for progress nudges.
export function recordMatch(profiles, summary, opts = {}) {
  // opts.onlyPlayerIdx — only fold this one player's data into profiles. Used
  // by online matches so each device records its own user and not the
  // opponents (whose stats live on their own devices). When omitted, every
  // human player in the summary is recorded as before.
  const newUnlocks = {};
  const progressUnlocks = {};
  const progressGains = {};
  const earnedPerPlayer = evaluateMatch(summary, profiles);
  const setsPerPlayer = summariseSetsPerPlayer(summary);
  const onlyIdx = (typeof opts.onlyPlayerIdx === "number") ? opts.onlyPlayerIdx : null;

  for (const p of summary.players) {
    if (p.kind === "cpu") continue;       // CPUs don't get profiles or achievements
    if (onlyIdx != null && p.idx !== onlyIdx) continue;
    const prof = ensureProfile(profiles, p.name);
    if (!prof) continue;
    if (!prof.progress) prof.progress = {};   // backfill for older saved profiles

    prof.stats.matchesPlayed += 1;
    if (p.isWinner) prof.stats.matchesWon += 1;
    prof.stats.totalScore += p.finalScore;
    prof.stats.bestMatch = prof.stats.bestMatch == null
      ? p.finalScore
      : Math.min(prof.stats.bestMatch, p.finalScore);
    prof.stats.worstMatch = prof.stats.worstMatch == null
      ? p.finalScore
      : Math.max(prof.stats.worstMatch, p.finalScore);
    prof.stats.roundsPlayed += summary.roundHistory.length;
    prof.stats.roundsWon += p.roundsWon;
    prof.stats.lastSeen = summary.date;

    prof.matchHistory.unshift({
      date: summary.date,
      mode: summary.mode,
      finalScore: p.finalScore,
      position: p.position,
      totalPlayers: summary.totalPlayers,
      roundsPlayed: summary.roundHistory.length,
      roundsWon: p.roundsWon,
    });
    if (prof.matchHistory.length > HISTORY_CAP) {
      prof.matchHistory.length = HISTORY_CAP;
    }

    const earned = earnedPerPlayer[p.idx] || [];
    // Dedup by (id, mode) so the same achievement can be earned once per mode.
    const already = new Set(prof.achievements.map(a => `${a.id}::${a.matchContext && a.matchContext.mode}`));
    const fresh = [];
    for (const id of earned) {
      if (already.has(`${id}::${summary.mode}`)) continue;
      prof.achievements.push({
        id,
        unlockedAt: summary.date,
        matchContext: {
          mode: summary.mode,
          opponentCount: summary.totalPlayers - 1,
          score: p.finalScore,
          position: p.position,
        },
      });
      fresh.push(id);
    }
    if (fresh.length) newUnlocks[p.idx] = fresh;

    // Fold this player's match feats into the per-mode progress bucket. Skip
    // scoring mode (no card-level events available).
    const feats = setsPerPlayer[p.idx];
    if (feats && PROGRESS_ACHIEVEMENTS.some(a => a.modes.includes(summary.mode))) {
      const modeBucket = prof.progress[summary.mode] || (prof.progress[summary.mode] = {});
      const gains = [];
      const unlocked = [];
      for (const def of PROGRESS_ACHIEVEMENTS) {
        if (!def.modes.includes(summary.mode)) continue;
        const row = modeBucket[def.id] || { value: 0, items: {} };
        const before = row.value;
        const beforeKeys = Object.keys(row.items || {});
        const newItems = [];
        if (def.id === "suit_sampler") {
          for (const s of feats.runsBySuit) {
            if (!row.items[s]) { row.items[s] = true; newItems.push(s); }
          }
          row.value = Object.keys(row.items).length;
        } else if (def.id === "quad_collector") {
          for (const r of feats.quadsByRank) {
            if (!row.items[r]) { row.items[r] = true; newItems.push(r); }
          }
          row.value = Object.keys(row.items).length;
        } else if (def.id === "long_run") {
          if (feats.longestRun > row.value) row.value = Math.min(RUN_TARGET, feats.longestRun);
        }
        const after = row.value;
        modeBucket[def.id] = row;
        if (after > before || newItems.length) {
          gains.push({ id: def.id, before, after, target: def.target, newItems });
        }
        if (before < def.target && after >= def.target) unlocked.push(def.id);
      }
      if (gains.length) progressGains[p.idx] = gains;
      if (unlocked.length) progressUnlocks[p.idx] = unlocked;
    }
  }

  return { newUnlocks, progressUnlocks, progressGains };
}

export function achievementById(id) {
  return ACHIEVEMENTS.find(a => a.id === id)
    || PROGRESS_ACHIEVEMENTS.find(a => a.id === id)
    || null;
}

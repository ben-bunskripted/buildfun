// Achievement registry + pure evaluator.
//
// Each entry is a static definition + an `evaluate(ctx)` function that returns
// true if the player just earned it. The evaluator runs per-player at match end.
//
// ctx shape (built by evaluateMatch below):
//   { player, summary, profile }
//     player   — the {idx, name, finalScore, position, isWinner, isDealer,
//                       roundsWon} record from buildMatchSummary
//     summary  — the whole match summary (mode, roundHistory, matchEvents, etc.)
//     profile  — this player's profile BEFORE this match (for lifetime/streak)

// keyFor duplicated from profiles.js to avoid a circular import.
const profileKey = (name) => String(name || "").trim().toLowerCase();

// Online matches use the same engine + matchEvents as multiplayer/cpu, so
// they get the same per-mode achievement & progress tracking as the local
// modes — just bucketed separately so a player's online record is its own
// thing in the profile screen.
export const ALL_MODES = ["multiplayer", "cpu", "scoring", "online"];
export const PLAY_MODES = ["multiplayer", "cpu", "online"];

export const MODE_LABELS = {
  multiplayer: "Multiplayer",
  cpu: "Solo",
  scoring: "Scoring",
  online: "Online",
};

export const SUIT_NAMES = { S: "Spades", H: "Hearts", D: "Diamonds", C: "Clubs" };
export const SUIT_GLYPHS = { S: "♠", H: "♥", D: "♦", C: "♣" };
export const RANK_ORDER = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
export const RUN_TARGET = 13;

function isCardDetailMode(summary) {
  return summary.mode !== "scoring";
}

// Reduce a match's per-set events into the final shape of each set on the
// table by the time the round ended. `setsPlayed` logs every open + extend,
// so keeping the last entry per setId gives us the final length/wildCount.
function finalSetsFromEvents(summary) {
  if (!isCardDetailMode(summary)) return [];
  const events = (summary.matchEvents && summary.matchEvents.setsPlayed) || [];
  const lastBySetId = new Map();
  for (const e of events) lastBySetId.set(e.setId, e);
  return Array.from(lastBySetId.values());
}

// Like finalSetsFromEvents, but also collects every player who contributed to a
// set (opener + anyone who added to it). Run-length feats credit all of them,
// and a set's final length includes additions made by other players.
// `byIdx` falls back to `playerIdx` for matches saved before it was logged.
function finalSetsWithContributors(summary) {
  if (!isCardDetailMode(summary)) return [];
  const events = (summary.matchEvents && summary.matchEvents.setsPlayed) || [];
  const map = new Map();
  for (const e of events) {
    let rec = map.get(e.setId);
    if (!rec) { rec = { last: e, contributors: new Set() }; map.set(e.setId, rec); }
    rec.last = e;
    rec.contributors.add(e.byIdx != null ? e.byIdx : e.playerIdx);
  }
  return Array.from(map.values());
}

// Public: the same reduction, exposed so the profile updater can scan the
// finalised match for suits, ranks, and longest-run feats per player.
export function summariseSetsPerPlayer(summary) {
  const out = {};
  for (const player of summary.players) out[player.idx] = { runsBySuit: new Set(), quadsByRank: new Set(), longestRun: 0 };
  for (const { last, contributors } of finalSetsWithContributors(summary)) {
    if (last.type === "run" && last.suit) {
      // Suit credit goes to the player who opened the run.
      const owner = out[last.playerIdx];
      if (owner) owner.runsBySuit.add(last.suit);
      // Run-length credit goes to everyone who built it — opener and adders —
      // and the length already includes other players' additions.
      for (const idx of contributors) {
        const b = out[idx];
        if (b && last.length > b.longestRun) b.longestRun = last.length;
      }
    } else if (last.type === "number" && last.length >= 4 && last.rank) {
      const owner = out[last.playerIdx];
      if (owner) owner.quadsByRank.add(last.rank);
    }
  }
  return out;
}

function roundsWonByPlayer(roundHistory, idx) {
  return roundHistory.filter(r => r.winnerIdx === idx).length;
}

function maxConsecutiveRoundWins(roundHistory, idx) {
  let best = 0, cur = 0;
  for (const r of roundHistory) {
    if (r.winnerIdx === idx) { cur += 1; best = Math.max(best, cur); }
    else cur = 0;
  }
  return best;
}

// Lifetime helpers — scoped to the just-finished match's mode so each mode has
// its own "first win", "10 matches played", etc.
function priorWinsInMode(profile, mode) {
  if (!profile) return 0;
  return profile.matchHistory.filter(m => m.mode === mode && m.position === 1).length;
}
function priorMatchesInMode(profile, mode) {
  if (!profile) return 0;
  return profile.matchHistory.filter(m => m.mode === mode).length;
}
function priorSecondsInMode(profile, mode) {
  if (!profile) return 0;
  return profile.matchHistory.filter(m => m.mode === mode && m.position === 2).length;
}
function priorAchievementsInMode(profile, mode) {
  if (!profile) return 0;
  return profile.achievements.filter(a => a.matchContext && a.matchContext.mode === mode).length;
}

export const ACHIEVEMENTS = [
  // ---- Score-based (any mode) ----
  {
    id: "untouchable", name: "Untouchable", icon: "🛡️", category: "score", modes: ALL_MODES,
    description: "Finish a match with 0 points.",
    evaluate: ({ player }) => player.finalScore === 0,
  },
  {
    id: "whisker", name: "Whisker", icon: "🪶", category: "score", modes: ALL_MODES,
    description: "Finish under 10 points.",
    evaluate: ({ player }) => player.finalScore > 0 && player.finalScore < 10,
  },
  {
    id: "tidy", name: "Tidy", icon: "✨", category: "score", modes: ALL_MODES,
    description: "Finish under 100 points.",
    evaluate: ({ player }) => player.finalScore >= 10 && player.finalScore < 100,
  },
  {
    id: "train_wreck", name: "Train Wreck", icon: "🚂", category: "score", modes: ALL_MODES,
    description: "Finish over 300 points.",
    evaluate: ({ player }) => player.finalScore > 300,
  },

  // ---- Match position (any mode) ----
  {
    id: "wire_to_wire", name: "Wire-to-Wire", icon: "🏁", category: "match", modes: ALL_MODES,
    description: "Win the match after leading at every round-end.",
    evaluate: ({ player, summary }) => {
      if (!player.isWinner) return false;
      if (!summary.roundHistory.length) return false;
      for (const r of summary.roundHistory) {
        const lowest = Math.min(...r.cumulative);
        if (r.cumulative[player.idx] !== lowest) return false;
      }
      return true;
    },
  },
  {
    id: "comeback_kid", name: "Comeback Kid", icon: "🔄", category: "match", modes: ALL_MODES,
    description: "Win the match after being last at end of round 1.",
    evaluate: ({ player, summary }) => {
      if (!player.isWinner) return false;
      const r1 = summary.roundHistory[0];
      if (!r1) return false;
      const highest = Math.max(...r1.cumulative);
      return r1.cumulative[player.idx] === highest && summary.totalPlayers > 1;
    },
  },
  {
    id: "photo_finish", name: "Photo Finish", icon: "📸", category: "match", modes: ALL_MODES,
    description: "Win by 5 points or fewer.",
    evaluate: ({ player, summary }) => {
      if (!player.isWinner || summary.totalPlayers < 2) return false;
      const others = summary.players.filter(p => p.idx !== player.idx).map(p => p.finalScore);
      const runnerUp = Math.min(...others);
      return runnerUp - player.finalScore <= 5;
    },
  },
  {
    id: "landslide", name: "Landslide", icon: "🏔️", category: "match", modes: ALL_MODES,
    description: "Win by more than 100 points.",
    evaluate: ({ player, summary }) => {
      if (!player.isWinner || summary.totalPlayers < 2) return false;
      const others = summary.players.filter(p => p.idx !== player.idx).map(p => p.finalScore);
      const runnerUp = Math.min(...others);
      return runnerUp - player.finalScore > 100;
    },
  },

  // ---- Per round / card detail ----
  {
    id: "sniper", name: "Sniper", icon: "🎯", category: "round", modes: PLAY_MODES,
    description: "Go out before any opponent has opened.",
    evaluate: ({ player, summary }) => {
      if (!isCardDetailMode(summary)) return false;
      for (const r of summary.matchEvents.rounds) {
        if (r.winnerIdx !== player.idx || !r.openedOrder) continue;
        const opponentOpenedBefore = r.openedOrder.some(idx => idx !== player.idx);
        if (!opponentOpenedBefore) return true;
      }
      return false;
    },
  },
  {
    id: "whoopsie", name: "Whoopsie", icon: "🙈", category: "card", modes: PLAY_MODES,
    description: "Discard a card that's the round's wildcard rank.",
    evaluate: ({ player, summary }) => {
      if (!isCardDetailMode(summary)) return false;
      return summary.matchEvents.discards.some(d => d.playerIdx === player.idx && d.wasWild);
    },
  },
  {
    id: "loaded", name: "Loaded", icon: "🎒", category: "card", modes: ALL_MODES,
    description: "End a round holding 4+ cards each worth 10+.",
    // Proxy: per-round score >= 50 (covers all true 4×10+ holdings). Works in
    // scoring mode because the scorekeeper enters per-round scores.
    evaluate: ({ player, summary }) =>
      summary.roundHistory.some(r => r.winnerIdx !== player.idx && r.scores[player.idx] >= 50),
  },
  {
    id: "big_wild", name: "Big Wild", icon: "🃏", category: "card", modes: PLAY_MODES,
    description: "Go out in a round where you played a set with 2+ wildcards.",
    evaluate: ({ player, summary }) => {
      if (!isCardDetailMode(summary)) return false;
      return summary.matchEvents.rounds.some(r => r.winnerIdx === player.idx && (r.winnerWildsOnTable || 0) >= 2);
    },
  },
  {
    id: "dealers_choice", name: "Dealer's Choice", icon: "🎩", category: "round", modes: ALL_MODES,
    description: "Win a round in which you were the dealer.",
    evaluate: ({ player, summary }) =>
      summary.matchEvents.rounds.some(r => r.winnerIdx === player.idx && r.dealerIdx === player.idx),
  },
  {
    id: "hat_trick", name: "Hat Trick", icon: "🎉", category: "round", modes: ALL_MODES,
    description: "Win 3 rounds in a single match.",
    evaluate: ({ player, summary }) => roundsWonByPlayer(summary.roundHistory, player.idx) >= 3,
  },
  {
    id: "hot_streak", name: "Hot Streak", icon: "🔥", category: "round", modes: ALL_MODES,
    description: "Win 3 rounds in a row in one match.",
    evaluate: ({ player, summary }) => maxConsecutiveRoundWins(summary.roundHistory, player.idx) >= 3,
  },
  {
    id: "ace_closer", name: "Ace Closer", icon: "♠️", category: "round", modes: ALL_MODES,
    description: "Win the final round (A*).",
    evaluate: ({ player, summary }) => {
      const last = summary.matchEvents.rounds[summary.matchEvents.rounds.length - 1];
      return !!last && last.winnerIdx === player.idx && last.round === summary.roundHistory.length && last.round === 14;
    },
  },
  {
    id: "long_runner", name: "Long Runner", icon: "🏃", category: "card", modes: PLAY_MODES,
    description: "Help build a run of 5 or more in a single match.",
    evaluate: ({ player, summary }) =>
      finalSetsWithContributors(summary).some(({ last, contributors }) =>
        last.type === "run" && last.length >= 5 && contributors.has(player.idx)),
  },
  {
    id: "quad_squad", name: "Quad Squad", icon: "🃏", category: "card", modes: PLAY_MODES,
    description: "Lay down a 4-of-a-kind number set in a single match.",
    evaluate: ({ player, summary }) =>
      finalSetsFromEvents(summary).some(s => s.playerIdx === player.idx && s.type === "number" && s.length >= 4),
  },
  {
    id: "rainbow_round", name: "Rainbow Round", icon: "🌈", category: "card", modes: PLAY_MODES,
    description: "Play a run in all four suits in a single match.",
    evaluate: ({ player, summary }) => {
      const suits = new Set();
      for (const s of finalSetsFromEvents(summary)) {
        if (s.playerIdx === player.idx && s.type === "run" && s.suit) suits.add(s.suit);
      }
      return suits.size >= 4;
    },
  },

  // ---- Lifetime / meta (any mode — but counted per-mode) ----
  {
    id: "first_blood", name: "First Blood", icon: "🩸", category: "meta", modes: ALL_MODES,
    description: "Win your first match in this mode.",
    evaluate: ({ player, summary, profile }) =>
      player.isWinner && priorWinsInMode(profile, summary.mode) === 0,
  },
  {
    id: "veteran", name: "Veteran", icon: "🎖️", category: "meta", modes: ALL_MODES,
    description: "Play 10 matches in this mode.",
    evaluate: ({ summary, profile }) => priorMatchesInMode(profile, summary.mode) + 1 >= 10,
  },
  {
    id: "centurion", name: "Centurion", icon: "💯", category: "meta", modes: ALL_MODES,
    description: "Play 100 matches in this mode.",
    evaluate: ({ summary, profile }) => priorMatchesInMode(profile, summary.mode) + 1 >= 100,
  },
  {
    id: "bridesmaid", name: "Bridesmaid", icon: "💐", category: "meta", modes: ALL_MODES,
    description: "Finish 2nd in 5 matches in this mode.",
    evaluate: ({ player, summary, profile }) =>
      priorSecondsInMode(profile, summary.mode) + (player.position === 2 ? 1 : 0) >= 5,
  },
  {
    id: "collector", name: "Collector", icon: "🏆", category: "meta", modes: ALL_MODES,
    description: "Unlock 10 unique achievements in this mode.",
    // Counts prior unlocks IN THIS MODE; +1 implicit for this one = 10.
    evaluate: ({ summary, profile }) => priorAchievementsInMode(profile, summary.mode) >= 9,
  },
];

// Progress-based, lifetime, per-mode achievements. Unlike the one-shot
// evaluators above, these track cumulative card-play feats across every match
// in the mode — the profile screen draws each as a bar growing toward target.
// Storage lives on each profile under `progress[mode]`.
//
// Shape: { id, name, icon, description, target, modes,
//          progressLabel(value), itemDetail(progress) }
//   progress is read from profile.progress[mode][id].value (number) and
//   .items (object, e.g. {S: true, H: true}) for the multi-item variants.
export const PROGRESS_ACHIEVEMENTS = [
  {
    id: "suit_sampler",
    name: "Suit Sampler",
    icon: "🌈",
    description: "Play a run with each of the four suits.",
    target: 4,
    modes: PLAY_MODES,
    // Render: ♠ ♥ ♦ ♣ chips, lit when present in .items.
    items: { keys: ["S", "H", "D", "C"], labelFor: (k) => SUIT_GLYPHS[k], titleFor: (k) => SUIT_NAMES[k] },
  },
  {
    id: "quad_collector",
    name: "Quad Collector",
    icon: "🎴",
    description: "Lay down a 4-of-a-kind number set for every rank.",
    target: 13,
    modes: PLAY_MODES,
    items: { keys: RANK_ORDER.slice(), labelFor: (k) => k, titleFor: (k) => `Rank ${k}` },
  },
  {
    id: "long_run",
    name: "Long Run",
    icon: "🏃",
    description: "Build the longest run you can — A through K.",
    target: RUN_TARGET,
    modes: PLAY_MODES,
    // No item chips — just a bar growing to 13.
  },
];

export function progressAchievementById(id) {
  return PROGRESS_ACHIEVEMENTS.find(a => a.id === id) || null;
}

// Read progress for one player in one mode. Returns { suit_sampler: {value, items}, ... }
// Defaults every progress achievement to zero so the renderer can always show a bar.
export function readProgress(profile, mode) {
  const out = {};
  const raw = (profile && profile.progress && profile.progress[mode]) || {};
  for (const def of PROGRESS_ACHIEVEMENTS) {
    const row = raw[def.id] || {};
    out[def.id] = {
      value: Math.max(0, Math.min(def.target, row.value || 0)),
      items: row.items ? { ...row.items } : {},
    };
  }
  return out;
}

// Run every achievement against every player. Returns { [playerIdx]: [id,...] }.
// Profiles param is the *current* profiles store (pre-record) so lifetime
// evaluators see the previous totals.
export function evaluateMatch(summary, profiles) {
  const out = {};
  for (const player of summary.players) {
    const profile = profiles ? profiles.players[profileKey(player.name)] : null;
    const earned = [];
    for (const a of ACHIEVEMENTS) {
      if (a.modes && !a.modes.includes(summary.mode)) continue;
      try {
        if (a.evaluate({ player, summary, profile })) earned.push(a.id);
      } catch (_err) {
        // Defensive: a broken evaluator never blocks the rest.
      }
    }
    out[player.idx] = earned;
  }
  return out;
}

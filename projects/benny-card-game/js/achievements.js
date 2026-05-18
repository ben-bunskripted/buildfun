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

export const ALL_MODES = ["multiplayer", "cpu", "scoring"];
export const PLAY_MODES = ["multiplayer", "cpu"];

export const MODE_LABELS = {
  multiplayer: "Multiplayer",
  cpu: "Solo vs CPU",
  scoring: "Scoring",
};

function isCardDetailMode(summary) {
  return summary.mode !== "scoring";
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

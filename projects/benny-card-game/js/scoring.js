// Scoring-mode state machine. No deck, no hands, no table — just round
// tracking and cumulative scores. Reuses WILDCARD_ORDER and TOTAL_ROUNDS
// from game.js so wildcard rotation matches play modes.

import { WILDCARD_ORDER, TOTAL_ROUNDS, STATE_VERSION } from "./game.js";

export function createScoringMatch(playerNames, dealerIndex = 0) {
  return {
    version: STATE_VERSION,
    mode: "scoring",
    players: playerNames.map(name => ({ name, score: 0 })),
    dealerIndex,
    round: 0,
    wildcardRank: null,
    perRoundScores: [],
    roundWinner: null,
    roundHistory: [],
    phase: "matchStart",
  };
}

export function startScoringRound(state) {
  state.round += 1;
  state.wildcardRank = WILDCARD_ORDER[state.round - 1];
  state.perRoundScores = state.players.map(() => 0);
  state.roundWinner = null;
  state.phase = "entering";
  return state;
}

// scores: array of numbers aligned with players[]; winner's score MUST be 0.
// Returns {ok:true} or {ok:false, reason}.
export function submitScoringRound(state, winnerIdx, scores) {
  if (state.phase !== "entering") return { ok: false, reason: "Not awaiting scores." };
  if (winnerIdx == null || winnerIdx < 0 || winnerIdx >= state.players.length) {
    return { ok: false, reason: "Pick a winner." };
  }
  if (!Array.isArray(scores) || scores.length !== state.players.length) {
    return { ok: false, reason: "Bad score array." };
  }
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (!Number.isFinite(s) || s < 0 || s > 999 || Math.floor(s) !== s) {
      return { ok: false, reason: `Invalid score for ${state.players[i].name}.` };
    }
  }
  if (scores[winnerIdx] !== 0) return { ok: false, reason: "Winner scores 0." };

  state.roundWinner = winnerIdx;
  state.perRoundScores = scores.slice();
  for (let i = 0; i < state.players.length; i++) state.players[i].score += scores[i];
  if (!Array.isArray(state.roundHistory)) state.roundHistory = [];
  state.roundHistory.push({
    round: state.round,
    wildcardRank: state.wildcardRank,
    winnerIdx,
    scores: scores.slice(),
    cumulative: state.players.map(p => p.score),
  });
  state.phase = "roundOver";
  return { ok: true };
}

export function isScoringMatchOver(state) {
  return state.round >= TOTAL_ROUNDS && state.phase === "roundOver";
}

export function advanceScoringRound(state) {
  state.dealerIndex = (state.dealerIndex + 1) % state.players.length;
  startScoringRound(state);
}

export function scoringWinnerIndex(state) {
  let best = 0;
  for (let i = 1; i < state.players.length; i++) {
    if (state.players[i].score < state.players[best].score) best = i;
  }
  return best;
}

// Game state machine. Pure logic; no DOM access.

import { buildDeck, RANKS, CARD_POINTS, isWildcard } from "./cards.js";
import { shuffleInPlace } from "./rng.js";

export const WILDCARD_ORDER = ["A","2","3","4","5","6","7","8","9","10","J","Q","K","A"];
// Display labels per round. Distinct from WILDCARD_ORDER because the final round
// reuses the A wild rank but is labelled A* so players know it's the last one.
export const ROUND_NAMES = ["A","2","3","4","5","6","7","8","9","10","J","Q","K","A*"];
export const TOTAL_ROUNDS = WILDCARD_ORDER.length; // 14
export const STATE_VERSION = 1;

// createMatch(playerNames, dealerIndex)
//   — legacy: all players are "human", mode "multiplayer".
// createMatch(playerNames, dealerIndex, { mode, playerKinds, difficulties })
//   — opts.mode: "multiplayer" | "cpu"
//   — opts.playerKinds: array of "human" | "cpu", aligned with playerNames
//   — opts.difficulties: array of "easy" | "medium" | "hard" | undefined (cpu only)
export function createMatch(playerNames, dealerIndex, opts = {}) {
  const mode = opts.mode || "multiplayer";
  const kinds = opts.playerKinds || playerNames.map(() => "human");
  const diffs = opts.difficulties || playerNames.map(() => undefined);
  return {
    version: STATE_VERSION,
    mode,
    players: playerNames.map((name, i) => ({
      name,
      score: 0,
      hand: [],
      hasOpened: false,
      kind: kinds[i] || "human",
      difficulty: kinds[i] === "cpu" ? (diffs[i] || "medium") : undefined,
      memory: kinds[i] === "cpu" ? [] : undefined, // discard-pile observations (Hard AI)
    })),
    dealerIndex,
    currentPlayerIndex: dealerIndex,
    round: 0,
    wildcardRank: null,
    deck: [],
    discardPile: [],
    table: [],
    phase: "matchStart",
    dealerOpeningPending: false,
    lastDrawnCardId: null,
    setIdCounter: 0,
    roundWinner: null,
    perRoundScores: [],
    roundHistory: [],
  };
}

export function startNextRound(state) {
  state.round += 1;
  state.wildcardRank = WILDCARD_ORDER[state.round - 1];
  state.deck = shuffleInPlace(buildDeck());
  state.discardPile = [];
  state.table = [];
  state.lastDrawnCardId = null;
  state.roundWinner = null;
  state.perRoundScores = state.players.map(() => 0);

  // Reset per-round per-player state.
  for (const p of state.players) {
    p.hand = [];
    p.hasOpened = false;
  }

  // Deal 7 to each, then 1 extra to dealer.
  const n = state.players.length;
  for (let i = 0; i < 7; i++) {
    for (let k = 0; k < n; k++) {
      const idx = (state.dealerIndex + 1 + k) % n;
      state.players[idx].hand.push(state.deck.shift());
    }
  }
  state.players[state.dealerIndex].hand.push(state.deck.shift());

  state.currentPlayerIndex = state.dealerIndex;
  state.dealerOpeningPending = true;
  state.phase = "passing";
  return state;
}

// Begin the current player's turn: they may have been waiting on the pass screen.
export function beginTurn(state) {
  if (state.dealerOpeningPending && state.currentPlayerIndex === state.dealerIndex) {
    // Dealer opens — cannot draw, must discard.
    state.phase = "canAct"; // hasDrawn-equivalent is true
  } else {
    state.phase = "mustDraw";
  }
  state.lastDrawnCardId = null;
}

export function currentPlayer(state) { return state.players[state.currentPlayerIndex]; }

export function topOfDiscard(state) {
  return state.discardPile.length ? state.discardPile[state.discardPile.length - 1] : null;
}

// Draw a card from deck. If the deck is empty, reshuffle the discard pile
// (keeping its top card face up) — a standard card-game convention.
export function drawFromDeck(state) {
  if (state.phase !== "mustDraw") return { ok: false, reason: "You can't draw right now." };
  if (!state.deck.length) {
    if (state.discardPile.length <= 1) return { ok: false, reason: "No cards left to draw." };
    const top = state.discardPile.pop();
    state.deck = shuffleInPlace(state.discardPile);
    state.discardPile = [top];
  }
  const card = state.deck.shift();
  currentPlayer(state).hand.push(card);
  state.lastDrawnCardId = card.id;
  state.phase = "canAct";
  return { ok: true, card };
}

export function drawFromDiscard(state) {
  if (state.phase !== "mustDraw") return { ok: false, reason: "You can't draw right now." };
  if (!state.discardPile.length) return { ok: false, reason: "Discard pile is empty." };
  const card = state.discardPile.pop();
  currentPlayer(state).hand.push(card);
  state.lastDrawnCardId = card.id;
  state.phase = "canAct";
  return { ok: true, card };
}

// Place a brand-new set on the table.
// `arrangement` is one of the arrangements returned by validateNewSet.
// `arrangement.type` is 'number' or 'run'.
export function placeNewSet(state, arrangement) {
  if (state.phase !== "canAct") return { ok: false, reason: "Can't play a set now." };
  const player = currentPlayer(state);
  // Only one number set of a given rank may exist on the table — preventing
  // wildcard-padded duplicates that would represent >4 of a rank in play.
  if (arrangement.type === "number") {
    const dup = state.table.find(s => s.type === "number" && s.rank === arrangement.rank);
    if (dup) {
      return { ok: false, reason: `There's already a set of ${arrangement.rank}s on the table — add to that one instead.` };
    }
  }
  // Verify the player still holds each of these cards in hand.
  const cardIds = arrangement.cards.map(c => c.card.id);
  for (const id of cardIds) {
    if (!player.hand.some(c => c.id === id)) return { ok: false, reason: "Hand mismatch." };
  }
  // Must keep at least 1 card to discard at end of turn.
  if (player.hand.length - cardIds.length < 1) {
    return { ok: false, reason: "You must keep at least one card to discard." };
  }
  // Remove cards from hand.
  player.hand = player.hand.filter(c => !cardIds.includes(c.id));

  // Add set to table.
  const set = {
    id: `s${++state.setIdCounter}`,
    ownerIndex: state.currentPlayerIndex,
    type: arrangement.type,
    cards: arrangement.cards,
  };
  if (arrangement.type === "number") {
    set.rank = arrangement.rank;
  } else {
    set.suit = arrangement.suit;
    set.baseValue = arrangement.baseValue;
  }
  state.table.push(set);
  player.hasOpened = true;
  return { ok: true, set };
}

export function addToSet(state, setId, arrangement) {
  if (state.phase !== "canAct") return { ok: false, reason: "Can't add to a set now." };
  const player = currentPlayer(state);
  if (!player.hasOpened) return { ok: false, reason: "Open with your own set first." };
  const set = state.table.find(s => s.id === setId);
  if (!set) return { ok: false, reason: "Set not found." };

  // For number additions, arrangement.added are the new cards (no positions).
  if (set.type === "number") {
    const cardIds = arrangement.added.map(c => c.card.id);
    if (player.hand.length - cardIds.length < 1) {
      return { ok: false, reason: "Keep at least one card for your discard." };
    }
    for (const id of cardIds) {
      if (!player.hand.some(c => c.id === id)) return { ok: false, reason: "Hand mismatch." };
    }
    player.hand = player.hand.filter(c => !cardIds.includes(c.id));
    set.cards.push(...arrangement.added);
    return { ok: true };
  }

  // For runs, the addition arrangement carries newBaseValue, newLength, added[]
  const cardIds = arrangement.added.map(c => c.card.id);
  if (player.hand.length - cardIds.length < 1) {
    return { ok: false, reason: "Keep at least one card for your discard." };
  }
  for (const id of cardIds) {
    if (!player.hand.some(c => c.id === id)) return { ok: false, reason: "Hand mismatch." };
  }
  player.hand = player.hand.filter(c => !cardIds.includes(c.id));

  // Sort existing + added into one ordered run.
  const all = [...set.cards.map((c, i) => ({ ...c, __position: set.baseValue + i })), ...arrangement.added];
  all.sort((a, b) => a.__position - b.__position);
  // Recompute base + ordered list (strip __position).
  set.baseValue = arrangement.newBaseValue;
  set.cards = all.map(c => {
    const out = {
      card: c.card,
      isWild: c.isWild,
      representsRank: c.representsRank,
      representsSuit: c.representsSuit,
    };
    return out;
  });
  return { ok: true };
}

// Swap a real card from hand for a wildcard on the table.
export function swapWildcard(state, setId, positionIndex, naturalCardId) {
  if (state.phase !== "canAct") return { ok: false, reason: "Can't swap right now." };
  const player = currentPlayer(state);
  if (!player.hasOpened) return { ok: false, reason: "Open with your own set first." };
  const set = state.table.find(s => s.id === setId);
  if (!set) return { ok: false, reason: "Set not found." };
  const target = set.cards[positionIndex];
  if (!target || !target.isWild) return { ok: false, reason: "Target isn't a wildcard." };
  const naturalIdx = player.hand.findIndex(c => c.id === naturalCardId);
  if (naturalIdx === -1) return { ok: false, reason: "Card not in hand." };
  const natural = player.hand[naturalIdx];

  // The wildcard goes to hand, replaced by the natural in the set.
  set.cards[positionIndex] = {
    card: natural,
    isWild: false,
    representsRank: target.representsRank,
    representsSuit: target.representsSuit,
  };
  player.hand.splice(naturalIdx, 1);
  player.hand.push(target.card); // wildcard returns to hand
  state.lastDrawnCardId = target.card.id; // highlight the newly held wildcard
  return { ok: true };
}

// Discard a single card to end the turn. Triggers win check.
export function discard(state, cardId) {
  if (state.phase !== "canAct" && state.phase !== "mustDiscard") {
    return { ok: false, reason: "Can't discard now." };
  }
  const player = currentPlayer(state);
  const idx = player.hand.findIndex(c => c.id === cardId);
  if (idx === -1) return { ok: false, reason: "Card not in hand." };
  const card = player.hand[idx];
  player.hand.splice(idx, 1);
  state.discardPile.push(card);
  state.lastDrawnCardId = null;

  // CPUs with memory observe every card that lands face-up.
  for (const p of state.players) {
    if (p.kind === "cpu" && Array.isArray(p.memory) && !p.memory.includes(card.id)) {
      p.memory.push(card.id);
    }
  }

  if (player.hand.length === 0) {
    // Round won.
    state.roundWinner = state.currentPlayerIndex;
    finalizeRoundScoring(state);
    state.phase = "roundOver";
    return { ok: true, wonRound: true };
  }

  // Pass to next player.
  state.dealerOpeningPending = false;
  state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
  state.phase = "passing";
  return { ok: true, wonRound: false };
}

// Serialize/hydrate are pure JSON round-trips since state contains only
// plain objects, arrays, primitives, and (intentionally) no functions.
export function serialize(state) {
  return JSON.parse(JSON.stringify(state));
}
export function hydrate(snapshot) {
  // Snapshot is already a plain object. We just trust the version stamp.
  if (!snapshot || snapshot.version !== STATE_VERSION) return null;
  return snapshot;
}

function finalizeRoundScoring(state) {
  const wild = state.wildcardRank;
  state.perRoundScores = state.players.map((p, i) => {
    if (i === state.roundWinner) return 0;
    let total = 0;
    for (const c of p.hand) {
      total += isWildcard(c, wild) ? 15 : CARD_POINTS[c.rank];
    }
    return total;
  });
  state.players.forEach((p, i) => { p.score += state.perRoundScores[i]; });
  if (!Array.isArray(state.roundHistory)) state.roundHistory = [];
  state.roundHistory.push({
    round: state.round,
    wildcardRank: state.wildcardRank,
    winnerIdx: state.roundWinner,
    scores: state.perRoundScores.slice(),
    cumulative: state.players.map(p => p.score),
  });
}

export function isMatchOver(state) {
  return state.round >= TOTAL_ROUNDS && state.phase === "roundOver";
}

export function advanceToNextRound(state) {
  // The dealer moves clockwise to the next player.
  state.dealerIndex = (state.dealerIndex + 1) % state.players.length;
  startNextRound(state);
}

export function matchWinnerIndex(state) {
  let best = 0;
  for (let i = 1; i < state.players.length; i++) {
    if (state.players[i].score < state.players[best].score) best = i;
  }
  return best;
}

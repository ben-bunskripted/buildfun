// Server-side game-engine wrapper. The browser engine lives at
// projects/benny-card-game/js/game.js (+ rules.js, cards.js, rng.js). It is
// pure (no DOM at module load) so we import it directly here — single source
// of truth for game rules. esbuild bundles the imports at function build time.
//
// Two responsibilities:
//   1) `applyAction(state, seat, action)` — validate + apply a single action
//      from the actor identified by `seat`. Returns `{ok, reason}` or
//      `{ok: true, recordedAction}` where recordedAction is the public-facing
//      version of the action that gets appended to last_turn.actions.
//   2) `redactStateForSeat(state, seat)` — return a deep copy with every
//      player's hand redacted EXCEPT the caller's seat, and the deck replaced
//      with same-length opaque placeholders. Never reveals hidden info.

import {
  createMatch, startNextRound, beginTurn,
  drawFromDeck, drawFromDiscard,
  placeNewSet, addToSet, swapWildcard, discard,
  isNoWayOut, finalizeNoWayOut,
  isMatchOver, advanceToNextRound, serialize,
} from "../../projects/benny-card-game/js/game.js";
import {
  validateNewSet, validateAddition, validateSwap,
} from "../../projects/benny-card-game/js/rules.js";

export {
  createMatch, startNextRound, beginTurn,
  isNoWayOut, finalizeNoWayOut,
  isMatchOver, advanceToNextRound, serialize,
};

// ---- Hidden-card sentinel ----
// Replaces a real card object in `hand` / `deck` when sending state to anyone
// who shouldn't see it. The client renders these as face-down backs. IDs are
// stable across a single response so the client's keyed renderers don't churn,
// but they're not real card IDs (no rank/suit) — there's nothing to leak.
function hiddenCard(seat, kind, i) {
  return { id: `hidden-${kind}-${seat}-${i}`, hidden: true };
}

export function redactStateForSeat(state, seat) {
  // Deep clone via JSON so we don't mutate the canonical row.
  const copy = JSON.parse(JSON.stringify(state));
  if (Array.isArray(copy.players)) {
    copy.players.forEach((p, i) => {
      if (i === seat) return;
      const n = Array.isArray(p.hand) ? p.hand.length : 0;
      p.hand = Array.from({ length: n }, (_, j) => hiddenCard(i, "hand", j));
    });
  }
  if (Array.isArray(copy.deck)) {
    const n = copy.deck.length;
    copy.deck = Array.from({ length: n }, (_, j) => hiddenCard(-1, "deck", j));
  }
  return copy;
}

// ---- Action dispatcher ----
//
// `action` shapes (matching the existing client-side recording shapes so the
// spectator replay path keeps working):
//   { type: "drawDeck" }
//   { type: "drawDiscard" }
//   { type: "play", arrangement }
//   { type: "add", setId, arrangement }
//   { type: "swap", setId, positionIndex, naturalCardId }
//   { type: "discard", cardId }
//
// For "play" / "add" the client sends an arrangement. The server doesn't
// trust the cards inside — it looks each card up by id in the actor's actual
// hand, then re-runs the validator against the real cards, and finally
// matches the client's chosen arrangement signature so the right run
// interpretation (Ace high/low, baseValue) is picked.
//
// Returns:
//   { ok: false, reason } on failure
//   { ok: true, recordedAction, drawnCard? } on success.
//     - recordedAction is what we append to last_turn.actions (public-info only).
//     - drawnCard is set on drawDeck — sent back to the actor only, never to
//       spectators (it's not on recordedAction).
export function applyAction(state, seat, action) {
  if (!action || typeof action !== "object") return { ok: false, reason: "missing action" };
  if (state.currentPlayerIndex !== seat) return { ok: false, reason: "not your turn" };

  // The engine expects `state.phase` to allow the action. beginTurn() flips
  // a fresh "passing" turn into "mustDraw" (or "canAct" for the dealer's
  // opening turn). We auto-advance here so the actor doesn't need a separate
  // "begin turn" round-trip.
  if (state.phase === "passing") beginTurn(state);

  switch (action.type) {
    case "drawDeck": {
      const r = drawFromDeck(state);
      if (!r.ok) return r;
      return { ok: true, recordedAction: { type: "drawDeck" }, drawnCard: r.card };
    }
    case "drawDiscard": {
      const r = drawFromDiscard(state);
      if (!r.ok) return r;
      return { ok: true, recordedAction: { type: "drawDiscard", card: r.card } };
    }
    case "play": {
      const player = state.players[seat];
      const cardIds = extractCardIds(action.arrangement && action.arrangement.cards);
      if (!cardIds) return { ok: false, reason: "bad arrangement" };
      const realCards = pickHandCards(player, cardIds);
      if (!realCards) return { ok: false, reason: "card not in hand" };
      const v = validateNewSet(realCards, state.wildcardRank);
      if (!v.ok) return v;
      const arrangement = matchNewSetArrangement(v, action.arrangement);
      if (!arrangement) return { ok: false, reason: "no matching arrangement" };
      const r = placeNewSet(state, arrangement);
      if (!r.ok) return r;
      return { ok: true, recordedAction: { type: "play", arrangement } };
    }
    case "add": {
      const player = state.players[seat];
      const set = state.table.find(s => s.id === action.setId);
      if (!set) return { ok: false, reason: "set not found" };
      const addedSrc = action.arrangement && action.arrangement.added;
      const cardIds = extractCardIds(addedSrc);
      if (!cardIds) return { ok: false, reason: "bad arrangement" };
      const realCards = pickHandCards(player, cardIds);
      if (!realCards) return { ok: false, reason: "card not in hand" };
      const v = validateAddition(set, realCards, state.wildcardRank);
      if (!v.ok) return v;
      const arrangement = matchAdditionArrangement(set, v, action.arrangement);
      if (!arrangement) return { ok: false, reason: "no matching arrangement" };
      const r = addToSet(state, action.setId, arrangement);
      if (!r.ok) return r;
      return { ok: true, recordedAction: { type: "add", setId: action.setId, arrangement } };
    }
    case "swap": {
      const player = state.players[seat];
      const set = state.table.find(s => s.id === action.setId);
      if (!set) return { ok: false, reason: "set not found" };
      const natural = player.hand.find(c => c.id === action.naturalCardId);
      if (!natural) return { ok: false, reason: "card not in hand" };
      const v = validateSwap(set, action.positionIndex, natural, state.wildcardRank);
      if (!v.ok) return v;
      const r = swapWildcard(state, action.setId, action.positionIndex, action.naturalCardId);
      if (!r.ok) return r;
      return {
        ok: true,
        recordedAction: {
          type: "swap",
          setId: action.setId,
          positionIndex: action.positionIndex,
          naturalCardId: action.naturalCardId,
          natural: { id: natural.id, rank: natural.rank, suit: natural.suit },
        },
      };
    }
    case "discard": {
      const player = state.players[seat];
      const card = player.hand.find(c => c.id === action.cardId);
      if (!card) return { ok: false, reason: "card not in hand" };
      const r = discard(state, action.cardId);
      if (!r.ok) return r;
      return {
        ok: true,
        recordedAction: {
          type: "discard",
          cardId: action.cardId,
          card: { id: card.id, rank: card.rank, suit: card.suit },
        },
        wonRound: r.wonRound,
      };
    }
    default:
      return { ok: false, reason: `unknown action type: ${action.type}` };
  }
}

// ---- Helpers ----

function extractCardIds(cardsLikeArr) {
  if (!Array.isArray(cardsLikeArr)) return null;
  const ids = [];
  for (const entry of cardsLikeArr) {
    const id = entry && entry.card && entry.card.id;
    if (typeof id !== "string") return null;
    ids.push(id);
  }
  return ids;
}

function pickHandCards(player, cardIds) {
  if (!player || !Array.isArray(player.hand)) return null;
  const out = [];
  for (const id of cardIds) {
    const c = player.hand.find(h => h.id === id);
    if (!c) return null;
    out.push(c);
  }
  return out;
}

// Pick which arrangement the client wanted out of the validator's options.
// For number sets there's exactly one. For runs there can be several (Ace
// high/low, different baseValues). We match on the public fields the client
// sends — type, rank or suit+baseValue+length+ordered card-id sequence.
function matchNewSetArrangement(validation, requested) {
  if (validation.type === "number") {
    if (requested && requested.type !== "number") return null;
    return validation;     // validation already carries cards + rank
  }
  // run
  if (!requested || requested.type !== "run") return null;
  const baseValue = Number(requested.baseValue);
  const sig = arrangementCardSig(requested.cards);
  for (const arr of validation.arrangements) {
    if (arr.baseValue !== baseValue) continue;
    if (arr.suit !== requested.suit) continue;
    if (arrangementCardSig(arr.cards) !== sig) continue;
    return { type: "run", ...arr };
  }
  return null;
}

function matchAdditionArrangement(set, validation, requested) {
  if (validation.type === "number") {
    // Only one arrangement.
    return validation.arrangement || validation;
  }
  if (!requested) return null;
  const sig = arrangementCardSig(requested.added);
  const newBaseValue = Number(requested.newBaseValue);
  for (const arr of validation.arrangements) {
    if (arr.newBaseValue !== newBaseValue) continue;
    if (arrangementCardSig(arr.added) !== sig) continue;
    return arr;
  }
  return null;
}

// Signature an arrangement's card list by ordered id + isWild flag. Enough
// to disambiguate run interpretations without trusting any of the rank/suit
// metadata the client claims.
function arrangementCardSig(cards) {
  if (!Array.isArray(cards)) return "";
  return cards.map(c => {
    const id = c && c.card && c.card.id;
    const w = c && c.isWild ? "W" : "N";
    return `${w}:${id}`;
  }).join("|");
}

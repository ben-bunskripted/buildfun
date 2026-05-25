// Shared builders for the Benny test suites. Mirrors the real card/meld shapes
// the engine produces so hand-built fixtures behave exactly like dealt ones.

import { createMatch } from "../projects/benny-card-game/js/game.js";

// A real deck card: { id, rank, suit }. id is rank+suit, e.g. "10S", "AH".
export const card = (id) => ({ id, rank: id.slice(0, -1), suit: id.slice(-1) });
export const cards = (...ids) => ids.map(card);

// Meld-slot builders matching validateNewSet/placeNewSet output.
export const natSlot = (id) => {
  const c = card(id);
  return { card: c, isWild: false, representsRank: c.rank, representsSuit: c.suit };
};
export const wildSlot = (id, representsRank, representsSuit) => ({
  card: card(id),
  isWild: true,
  representsRank,
  representsSuit,
});

export const numberSet = (rank, slots, extra = {}) => ({
  id: extra.id || "set1",
  ownerIndex: extra.ownerIndex ?? 0,
  type: "number",
  rank,
  cards: slots,
});
export const runSet = (suit, baseValue, slots, extra = {}) => ({
  id: extra.id || "run1",
  ownerIndex: extra.ownerIndex ?? 0,
  type: "run",
  suit,
  baseValue,
  cards: slots,
});

// A bare match skeleton with the round-level fields populated so engine
// functions that touch state.matchEvents / wildcardRank don't trip. Hands,
// table, deck and phase are left for the test to set explicitly.
export function freshMatch(names = ["A", "B", "C", "D"], opts = {}) {
  const state = createMatch(names, opts.dealerIndex ?? 0, opts);
  state.round = opts.round ?? 1;
  state.wildcardRank = opts.wildcardRank ?? "K";
  return state;
}

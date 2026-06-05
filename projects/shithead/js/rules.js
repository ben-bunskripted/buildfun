// Sh!thead — pure rules. No state mutation, no DOM. Shared by the client engine
// (game.js / ai.js) and the online backend (server re-imports this module).
//
// Ranking ladder (low → high): 3 4 5 6 7 8 9 10 J Q K A, with 2 woven in low.
// Power cards: 2 (reset), 10 (burn), 7 (forces next play ≤7), 8 (invisible OR
// skip depending on options). Four-of-a-kind on the pile burns it.

export const RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
export const SUITS = ["S","H","D","C"];
export const SUIT_GLYPH = { S: "♠", H: "♥", D: "♦", C: "♣" };

// Climbing value. 2 sits just under 3 so a sorted hand reads naturally; it is
// always playable anyway (reset), so its ordinal rarely matters for legality.
export const VALUE = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8,
  "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14,
};

export function value(rank) { return VALUE[rank]; }

// Default rule options. The setup screen flips these; the engine reads them.
export function defaultOptions() {
  return {
    eightMode: "invisible",   // "invisible" (transparent) | "skip"
    sevenPower: true,         // 7 forces the next play to be ≤ 7 (else pick up)
    fourKindAcrossTurns: true,// completing a 4-of-a-kind over several turns burns
    replayOnBurn: true,       // burning the pile (10 / 4-kind) grants another turn
    swapPhase: true,          // pre-game hand↔face-up swap
  };
}

// A 2 and a 10 are always-legal powers. An 8 is too, but only in invisible mode
// (in skip mode it must climb normally, then skips the next player).
export function isAlwaysPlayable(rank, options) {
  if (rank === "2" || rank === "10") return true;
  if (rank === "8" && options.eightMode === "invisible") return true;
  return false;
}

export function isPowerRank(rank) {
  return rank === "2" || rank === "7" || rank === "8" || rank === "10";
}

// The card the next player must answer to. In invisible mode, 8s are see-through
// so we walk past them to the first solid card underneath. Returns null when the
// pile is effectively open (empty, or only 8s on top in invisible mode).
export function comparisonCard(pile, options) {
  if (!pile || pile.length === 0) return null;
  if (options.eightMode === "invisible") {
    for (let i = pile.length - 1; i >= 0; i--) {
      if (pile[i].rank !== "8") return pile[i];
    }
    return null; // nothing but 8s — open
  }
  return pile[pile.length - 1];
}

// Reduces the pile to a single requirement the next play must satisfy:
//   { kind: "free" }            → anything goes (empty pile, fresh reset, or a 2)
//   { kind: "max7" }            → must play value ≤ 7 (a 7 is showing)
//   { kind: "min", value: n }   → must play value ≥ n
export function requirement(pile, options) {
  const cc = comparisonCard(pile, options);
  if (!cc) return { kind: "free" };
  if (cc.rank === "2") return { kind: "free" };           // reset card
  if (cc.rank === "7" && options.sevenPower) return { kind: "max7" };
  return { kind: "min", value: value(cc.rank) };
}

// Can a card of this rank be legally laid given the current requirement?
export function canPlayRank(rank, req, options) {
  if (isAlwaysPlayable(rank, options)) return true;
  switch (req.kind) {
    case "free": return true;
    case "max7": return value(rank) <= 7;
    case "min": return value(rank) >= req.value;
    default: return true;
  }
}

// Convenience over the raw pile.
export function canPlayRankOnPile(rank, pile, options) {
  return canPlayRank(rank, requirement(pile, options), options);
}

// Does the player have ANY legal play from the given zone of cards?
export function hasLegalPlay(cards, pile, options) {
  const req = requirement(pile, options);
  return cards.some((c) => canPlayRank(c.rank, req, options));
}

// The set of distinct ranks in `cards` that are legal right now.
export function playableRanks(cards, pile, options) {
  const req = requirement(pile, options);
  const set = new Set();
  for (const c of cards) {
    if (canPlayRank(c.rank, req, options)) set.add(c.rank);
  }
  return [...set];
}

// Should laying these cards burn the pile? `pileAfter` is the discard pile with
// the freshly played cards already on top.
export function burnsPile(playedCards, pileAfter, options) {
  // A 10 (or several) torches the pile outright.
  if (playedCards.some((c) => c.rank === "10")) return true;
  // Four-of-a-kind. Across-turns: the top four cards share a rank. Otherwise the
  // burn only fires when all four arrived in this single play.
  if (options.fourKindAcrossTurns) {
    if (pileAfter.length >= 4) {
      const top = pileAfter.slice(-4);
      if (top.every((c) => c.rank === top[0].rank)) return true;
    }
  } else {
    if (playedCards.length >= 4 && playedCards.every((c) => c.rank === playedCards[0].rank)) {
      return true;
    }
  }
  return false;
}

// How many players an 8 (skip mode) should skip for this play.
export function skipCount(playedCards, options) {
  if (options.eightMode !== "skip") return 0;
  return playedCards.filter((c) => c.rank === "8").length;
}

// Sort ascending by climbing value (2 low → A high), suit as a stable tiebreak.
const SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3 };
export function compareForHand(a, b) {
  const dv = value(a.rank) - value(b.rank);
  if (dv !== 0) return dv;
  return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
}

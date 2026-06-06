// Sh!thead — pure rules. No state mutation, no DOM. Shared by the client engine
// (game.js / ai.js) and the online backend (server re-imports this module).
//
// Ranking ladder (low → high): 3 4 5 6 7 8 9 10 J Q K A, with 2 woven in low.
// Power cards (each toggleable in setup):
//   2  — reset (next player may play anything)
//   10 — burn (pile removed, play again)
//   7  — forces the next play to be ≤ 7
//   8  — reverse direction (default) | invisible (transparent) | skip
//   Joker — forces the next player to take the WHOLE pile, unless they answer
//           with a 3, which passes the obligation to the following player.
//   Four-of-a-kind on the pile burns it.
// A 3 has no special power on its own — it only acts as a joker defence.

export const RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
export const SUITS = ["S","H","D","C"];
export const SUIT_GLYPH = { S: "♠", H: "♥", D: "♦", C: "♣" };
export const JOKER = "JK";          // joker rank; suits "1" / "2" pick the art

// Climbing value. 2 sits just under 3 so a sorted hand reads naturally; it is
// always playable anyway (reset), so its ordinal rarely matters for legality.
// A joker sits above the Ace as a defensive fallback — it is normally resolved
// by the attack flow before it ever has to be compared.
export const VALUE = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8,
  "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14, "JK": 15,
};

export function value(rank) { return VALUE[rank]; }

// Default rule options. The setup screen flips these; the engine reads them.
// These mirror the default loadout offered in setup: 2, 10 and a reversing 8.
export function defaultOptions() {
  return {
    twoPower: true,           // 2 resets the pile (else it is just the lowest card)
    tenPower: true,           // 10 burns the pile (else a normal climbing card)
    sevenPower: false,        // 7 forces the next play to be ≤ 7 (else pick up)
    eightMode: "reverse",     // "reverse" | "invisible" (transparent) | "skip"
    jokers: false,            // include 2 jokers; a joker forces a full pickup
    fourKindAcrossTurns: true,// completing a 4-of-a-kind over several turns burns
    replayOnBurn: true,       // burning the pile (10 / 4-kind) grants another turn
    swapPhase: true,          // pre-game hand↔face-up swap
  };
}

export function isJoker(rank) { return rank === JOKER; }

// A 3 only matters as the answer to a joker — it has no power of its own.
export function isJokerDefence(rank) { return rank === "3"; }

// Can this rank answer a live joker attack? A 3 always can; and (when jokers are
// enabled) so can another joker — a joker laid on a joker acts as a 3, passing
// the obligation on rather than starting a fresh attack.
export function isJokerAnswer(rank, options) {
  return rank === "3" || (rank === JOKER && !!(options && options.jokers));
}

// Cards that can be laid on anything regardless of the pile requirement: an
// enabled 2 or 10, an invisible-mode 8, and (when in play) a joker.
export function isAlwaysPlayable(rank, options) {
  if (rank === "2" && options.twoPower) return true;
  if (rank === "10" && options.tenPower) return true;
  if (rank === "8" && options.eightMode === "invisible") return true;
  if (rank === JOKER && options.jokers) return true;
  return false;
}

export function isPowerRank(rank, options = defaultOptions()) {
  if (rank === "2") return !!options.twoPower;
  if (rank === "10") return !!options.tenPower;
  if (rank === "7") return !!options.sevenPower;
  if (rank === "8") return true;
  if (rank === JOKER) return !!options.jokers;
  return false;
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
// Note: a live joker on the pile is handled by the attack flow (see game.js),
// not here — requirement() is only consulted for ordinary climbing turns.
export function requirement(pile, options) {
  const cc = comparisonCard(pile, options);
  if (!cc) return { kind: "free" };
  if (cc.rank === "2" && options.twoPower) return { kind: "free" };   // reset card
  if (cc.rank === "7" && options.sevenPower) return { kind: "max7" };
  if (cc.rank === JOKER) return { kind: "free" };                     // see attack flow
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
  // A 10 (or several) torches the pile outright — when the 10 power is enabled.
  if (options.tenPower && playedCards.some((c) => c.rank === "10")) return true;
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

// Sort ascending by climbing value (2 low → A high, jokers last), suit as a
// stable tiebreak. Joker "suits" (1/2) fall back to a high order so they pair up.
const SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3 };
function suitOrder(suit) {
  return SUIT_ORDER[suit] === undefined ? 9 : SUIT_ORDER[suit];
}
export function compareForHand(a, b) {
  const dv = value(a.rank) - value(b.rank);
  if (dv !== 0) return dv;
  return suitOrder(a.suit) - suitOrder(b.suit);
}

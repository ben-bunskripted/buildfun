// Game rule validation for sets, runs, additions, and swaps.

import { RANKS, isWildcard } from "./cards.js";

// Numeric run values: A=1 OR 14, 2-10 face, J=11, Q=12, K=13.
const NON_ACE_VALUE = { "2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,"10":10,"J":11,"Q":12,"K":13 };
const VALUE_TO_RANK = { 1:"A", 2:"2", 3:"3", 4:"4", 5:"5", 6:"6", 7:"7", 8:"8", 9:"9", 10:"10", 11:"J", 12:"Q", 13:"K", 14:"A" };

function valueOf(rank, asAceHigh = false) {
  if (rank === "A") return asAceHigh ? 14 : 1;
  return NON_ACE_VALUE[rank];
}

// Annotate raw card objects with isWild flag for the round's wildcard rank.
export function annotate(card, wildcardRank) {
  return { card, isWild: isWildcard(card, wildcardRank) };
}

// ---------- Validate a brand-new set being played from hand ----------
// Returns an object describing one or more valid arrangements:
//   { ok: true, type: 'number', rank, cards: [{card, isWild, representsRank}] }
//   { ok: true, type: 'run', arrangements: [{suit, baseValue, length, cards: [...] }, ...] }
//   { ok: false, reason: '...' }
export function validateNewSet(rawCards, wildcardRank) {
  if (!rawCards || rawCards.length < 3) {
    return { ok: false, reason: "A set needs at least 3 cards. No pairs allowed." };
  }
  const annotated = rawCards.map(c => annotate(c, wildcardRank));
  const naturals = annotated.filter(a => !a.isWild);
  if (naturals.length === 0) {
    return { ok: false, reason: "A set needs at least one natural card." };
  }

  // Try number-set interpretation: every natural has the same rank.
  const ranks = new Set(naturals.map(a => a.card.rank));
  if (ranks.size === 1) {
    const r = naturals[0].card.rank;
    // Reject duplicate suits among natural cards (impossible with one deck, but guard).
    const naturalSuits = naturals.map(a => a.card.suit);
    if (new Set(naturalSuits).size !== naturalSuits.length) {
      return { ok: false, reason: "Duplicate suits in number set." };
    }
    const cards = annotated.map(a => ({
      card: a.card,
      isWild: a.isWild,
      representsRank: r,
      representsSuit: a.isWild ? undefined : a.card.suit,
    }));
    return { ok: true, type: "number", rank: r, cards };
  }

  // Otherwise try run interpretation: same suit + consecutive sequence.
  const suits = new Set(naturals.map(a => a.card.suit));
  if (suits.size > 1) {
    return { ok: false, reason: "Mixed suits with mixed ranks — that's neither a number set nor a run." };
  }
  const suit = [...suits][0];

  // Generate value combinations for aces (each ace is independently low or high).
  const aceIdx = [];
  naturals.forEach((a, i) => { if (a.card.rank === "A") aceIdx.push(i); });
  const wildCount = annotated.length - naturals.length;
  const totalLen = annotated.length;

  const arrangements = [];
  const seenSig = new Set();
  const aceCombos = 1 << aceIdx.length;
  for (let mask = 0; mask < aceCombos; mask++) {
    const values = naturals.map((a, i) => {
      if (a.card.rank !== "A") return NON_ACE_VALUE[a.card.rank];
      const k = aceIdx.indexOf(i);
      return ((mask >> k) & 1) ? 14 : 1;
    });
    const sortedVals = [...values].sort((x, y) => x - y);
    let dup = false;
    for (let k = 1; k < sortedVals.length; k++) if (sortedVals[k] === sortedVals[k-1]) { dup = true; break; }
    if (dup) continue;

    const minV = sortedVals[0];
    const maxV = sortedVals[sortedVals.length - 1];
    const naturalSpan = maxV - minV + 1;
    if (naturalSpan > totalLen) continue; // can't fit all naturals in totalLen positions
    const internalGap = naturalSpan - naturals.length;
    if (internalGap > wildCount) continue; // not enough wildcards to fill gaps
    const extra = wildCount - internalGap;

    for (let leftExt = 0; leftExt <= extra; leftExt++) {
      const rightExt = extra - leftExt;
      const baseValue = minV - leftExt;
      const endValue = maxV + rightExt;
      if (baseValue < 1 || endValue > 14) continue;
      // Rule: A run cannot wrap. baseValue<=endValue ensured, and 1<=base, end<=14.

      // Build the ordered sequence.
      const positions = new Array(totalLen).fill(null);
      // Place naturals.
      for (let i = 0; i < naturals.length; i++) {
        const pos = values[i] - baseValue;
        positions[pos] = {
          card: naturals[i].card,
          isWild: false,
          representsRank: VALUE_TO_RANK[values[i]],
          representsSuit: suit,
        };
      }
      // Fill wildcards into empty positions in any order; preserve their identity in stack order.
      const wildStack = annotated.filter(a => a.isWild).map(a => a.card);
      let wp = 0;
      for (let p = 0; p < totalLen; p++) {
        if (positions[p]) continue;
        const v = baseValue + p;
        const rr = VALUE_TO_RANK[v];
        positions[p] = {
          card: wildStack[wp++],
          isWild: true,
          representsRank: rr,
          representsSuit: suit,
        };
      }

      const sig = `${suit}|${baseValue}|${positions.map(p => p.isWild ? "W" : p.card.id).join("-")}`;
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);
      arrangements.push({ suit, baseValue, length: totalLen, cards: positions });
    }
  }

  if (!arrangements.length) {
    return { ok: false, reason: "Cards do not form a valid run (must be consecutive, same suit, no wrapping)." };
  }
  return { ok: true, type: "run", arrangements };
}

// Describe an arrangement for the wildcard prompt UI.
export function describeRunArrangement(a) {
  return a.cards.map(c => c.isWild ? `Wild=${c.representsRank}` : c.representsRank).join("-");
}

// ---------- Validate adding cards to an existing set ----------
// `set` is the existing set on the table (full {type, rank|suit, baseValue, cards}).
// Returns arrangements list (additions extending the set or filling — but a placed set has no gaps).
// For number sets there's at most one arrangement. For runs, possibly extend left or right (or both ends combined).
export function validateAddition(set, rawCards, wildcardRank) {
  if (!rawCards || rawCards.length < 1) {
    return { ok: false, reason: "Pick at least one card to add." };
  }
  const annotated = rawCards.map(c => annotate(c, wildcardRank));

  if (set.type === "number") {
    // Every natural card must match the set's rank; no duplicate suits with existing.
    const existingSuits = new Set(set.cards.filter(c => !c.isWild).map(c => c.card.suit));
    for (const a of annotated) {
      if (!a.isWild && a.card.rank !== set.rank) {
        return { ok: false, reason: `That card isn't a ${set.rank}.` };
      }
      if (!a.isWild) {
        if (existingSuits.has(a.card.suit)) {
          return { ok: false, reason: "That suit is already in the set." };
        }
        existingSuits.add(a.card.suit);
      }
    }
    const added = annotated.map(a => ({
      card: a.card,
      isWild: a.isWild,
      representsRank: set.rank,
      representsSuit: a.isWild ? undefined : a.card.suit,
    }));
    return { ok: true, type: "number", added, arrangement: { added } };
  }

  // Run. Existing set has fixed suit and baseValue.
  const setSuit = set.suit;
  // For each non-wild new card, check suit & determine its value.
  // Cards can extend the left (baseValue - k) or right (baseValue + length + j).
  // Wildcards are flexible — they take whatever rank their position implies.

  const naturals = annotated.filter(a => !a.isWild);
  const wildCount = annotated.length - naturals.length;

  for (const a of naturals) {
    if (a.card.suit !== setSuit) {
      return { ok: false, reason: "All cards in a run must share the same suit." };
    }
  }

  // Build possible value placements for each natural.
  // A natural with non-Ace rank has exactly one value. An Ace has two (1 or 14).
  // We need to pick left-extension and right-extension counts so the existing run extends.
  const lo = set.baseValue;
  const hi = set.baseValue + set.cards.length - 1;

  const arrangements = [];
  const aceIdx = [];
  naturals.forEach((a, i) => { if (a.card.rank === "A") aceIdx.push(i); });
  const aceCombos = 1 << aceIdx.length;
  const seenSig = new Set();

  for (let mask = 0; mask < aceCombos; mask++) {
    const values = naturals.map((a, i) => {
      if (a.card.rank !== "A") return NON_ACE_VALUE[a.card.rank];
      const k = aceIdx.indexOf(i);
      return ((mask >> k) & 1) ? 14 : 1;
    });
    // Each natural's value must be outside [lo, hi] (those positions are already filled).
    if (values.some(v => v >= lo && v <= hi)) continue;
    // Try left/right extension splits with the wildcards.
    // The set of new positions = {leftExt positions immediately left of lo} ∪ {rightExt positions immediately right of hi}.
    // Each natural value must land in one of those positions.
    for (let leftExt = 0; leftExt <= annotated.length; leftExt++) {
      const rightExt = annotated.length - leftExt;
      const newLo = lo - leftExt;
      const newHi = hi + rightExt;
      if (newLo < 1 || newHi > 14) continue;

      // All natural values must fit in either [newLo, lo-1] or [hi+1, newHi].
      let fits = true;
      for (const v of values) {
        if ((v >= newLo && v <= lo - 1) || (v >= hi + 1 && v <= newHi)) continue;
        fits = false; break;
      }
      if (!fits) continue;
      // No duplicate values among naturals.
      if (new Set(values).size !== values.length) continue;
      // Each natural occupies a distinct position. Build position → card map.
      const newPositions = new Map();
      let ok = true;
      for (let i = 0; i < naturals.length; i++) {
        const v = values[i];
        if (newPositions.has(v)) { ok = false; break; }
        newPositions.set(v, naturals[i].card);
      }
      if (!ok) continue;
      // Wildcards fill the rest of the new positions.
      const newSpotValues = [];
      for (let v = newLo; v <= lo - 1; v++) newSpotValues.push(v);
      for (let v = hi + 1; v <= newHi; v++) newSpotValues.push(v);
      const wildStack = annotated.filter(a => a.isWild).map(a => a.card);
      const added = [];
      let wp = 0;
      for (const v of newSpotValues) {
        if (newPositions.has(v)) {
          added.push({
            card: newPositions.get(v),
            isWild: false,
            representsRank: VALUE_TO_RANK[v],
            representsSuit: setSuit,
            __position: v,
          });
        } else {
          if (wp >= wildStack.length) { ok = false; break; }
          added.push({
            card: wildStack[wp++],
            isWild: true,
            representsRank: VALUE_TO_RANK[v],
            representsSuit: setSuit,
            __position: v,
          });
        }
      }
      if (!ok) continue;

      const sig = added.map(x => `${x.card.id}@${x.__position}`).sort().join("|") + `:${newLo}-${newHi}`;
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);

      arrangements.push({
        newBaseValue: newLo,
        newLength: newHi - newLo + 1,
        leftExt,
        rightExt,
        added, // ordered by position low→high
        suit: setSuit,
      });
    }
  }

  if (!arrangements.length) {
    return { ok: false, reason: "Those cards don't extend the run." };
  }
  return { ok: true, type: "run", arrangements };
}

// Describe an addition arrangement for wildcard placement prompts.
export function describeAddition(arr, existingSet) {
  const left = arr.added.filter(x => x.__position < existingSet.baseValue);
  const right = arr.added.filter(x => x.__position > existingSet.baseValue + existingSet.cards.length - 1);
  const parts = [];
  if (left.length) parts.push(`Prepend: ${left.map(x => x.isWild ? `Wild=${x.representsRank}` : x.representsRank).join("-")}`);
  if (right.length) parts.push(`Append: ${right.map(x => x.isWild ? `Wild=${x.representsRank}` : x.representsRank).join("-")}`);
  return parts.join("  •  ");
}

// ---------- Validate a swap: real card from hand for a wildcard on the table ----------
// `set` and `position` identify which wildcard. `naturalCard` is the card from hand.
export function validateSwap(set, positionIndex, naturalCard, wildcardRank) {
  const target = set.cards[positionIndex];
  if (!target || !target.isWild) return { ok: false, reason: "Pick a wildcard on the table." };
  if (isWildcard(naturalCard, wildcardRank)) return { ok: false, reason: "You can't swap a wildcard for a wildcard." };
  if (set.type === "number") {
    if (naturalCard.rank !== set.rank) {
      return { ok: false, reason: `That isn't a ${set.rank}.` };
    }
    const existingSuits = new Set(set.cards.filter((c, i) => i !== positionIndex && !c.isWild).map(c => c.card.suit));
    if (existingSuits.has(naturalCard.suit)) {
      return { ok: false, reason: "That suit is already in the set." };
    }
    return { ok: true };
  }
  // Run
  if (naturalCard.rank !== target.representsRank) {
    return { ok: false, reason: `Needs a ${target.representsRank} of ${target.representsSuit}.` };
  }
  if (naturalCard.suit !== target.representsSuit) {
    return { ok: false, reason: `Needs the matching suit (${target.representsSuit}).` };
  }
  return { ok: true };
}

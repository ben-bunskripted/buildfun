// CPU decision engine. Pure: reads state, returns an ordered Action[] for
// the caller to apply via the existing game.js engine functions.
//
// Action shapes (all carry a `narration` string for the recap card):
//   { type: "drawDeck",    narration }
//   { type: "drawDiscard", narration }
//   { type: "play", arrangement, narration }
//   { type: "add",  setId, arrangement, narration }
//   { type: "swap", setId, positionIndex, naturalCardId, narration }
//   { type: "discard", cardId, narration }

import { validateNewSet, validateAddition, validateSwap } from "./rules.js";
import { isWildcard, CARD_POINTS, SUIT_GLYPH } from "./cards.js";
import { topOfDiscard } from "./game.js";
import { randomInt } from "./rng.js";

// ---------- helpers ----------

function pointValue(card, wildRank) {
  return isWildcard(card, wildRank) ? 15 : CARD_POINTS[card.rank];
}
function cardLabel(card) { return card.rank + SUIT_GLYPH[card.suit]; }
function rankVal(r) { return r === "A" ? 14 : ({"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,"10":10,"J":11,"Q":12,"K":13})[r]; }

// Would this hand-card swap an already-placed wildcard? Returns the first
// match found (set id + position) or null. Used by both the discard chooser
// (to avoid giving up a swap-eligible card) and the draw chooser (to value
// the top of discard).
function findSwappableWildFor(card, table, wildRank) {
  if (isWildcard(card, wildRank)) return null;
  for (const set of table) {
    for (let i = 0; i < set.cards.length; i++) {
      if (!set.cards[i].isWild) continue;
      if (validateSwap(set, i, card, wildRank).ok) return { setId: set.id, positionIndex: i };
    }
  }
  return null;
}

// How many copies of `rank` are accounted for outside opponents' hands? Used
// when scoring wildcard placement in a run — a wild representing a rank with
// many visible copies is harder for opponents to swap.
function countSeenForRank(rank, suit, state, meIdx) {
  let n = 0;
  // My own hand.
  if (meIdx != null) {
    for (const c of state.players[meIdx].hand) {
      if (c.rank !== rank) continue;
      if (suit && c.suit !== suit) continue;
      n += 1;
    }
  }
  // Discard pile.
  for (const c of state.discardPile) {
    if (c.rank !== rank) continue;
    if (suit && c.suit !== suit) continue;
    n += 1;
  }
  // Cards already on the table.
  for (const set of state.table) {
    for (const slot of set.cards) {
      if (slot.isWild) continue;
      if (slot.card.rank !== rank) continue;
      if (suit && slot.card.suit !== suit) continue;
      n += 1;
    }
  }
  return n;
}

// ---------- enumeration ----------

function enumerateNewSets(hand, wildRank, table = []) {
  const out = [];
  const wilds = hand.filter(c => isWildcard(c, wildRank));
  const byRank = {};
  for (const c of hand) (byRank[c.rank] = byRank[c.rank] || []).push(c);
  // Ranks already represented by a number set on the table — can't start a parallel one.
  const tableRanks = new Set(table.filter(s => s.type === "number").map(s => s.rank));

  function record(arrangement, kind, cards) {
    const wildCount = arrangement.cards.filter(c => c.isWild).length;
    out.push({
      arrangement,
      kind,
      cardIds: cards.map(c => c.id),
      wildCount,
      valueFreed: cards.reduce((s, c) => s + pointValue(c, wildRank), 0),
    });
  }

  // Number sets — naturals of one rank + 0..k wildcards, total 3..4.
  for (const rank of Object.keys(byRank)) {
    if (rank === wildRank) continue;
    if (tableRanks.has(rank)) continue;
    const naturals = byRank[rank];
    for (let useNat = naturals.length; useNat >= 1; useNat--) {
      for (let useWild = 0; useWild <= wilds.length && useNat + useWild <= 4; useWild++) {
        if (useNat + useWild < 3) continue;
        const cards = naturals.slice(0, useNat).concat(wilds.slice(0, useWild));
        const v = validateNewSet(cards, wildRank);
        if (v.ok && v.type === "number") {
          record({ type: "number", rank: v.rank, cards: v.cards }, "number", cards);
        }
      }
    }
  }

  // Runs — for each suit, enumerate subsets of natural cards × 0..wilds.
  const bySuit = {};
  for (const c of hand) {
    if (isWildcard(c, wildRank)) continue;
    (bySuit[c.suit] = bySuit[c.suit] || []).push(c);
  }
  for (const suit of Object.keys(bySuit)) {
    const suited = bySuit[suit];
    const n = suited.length;
    if (n + wilds.length < 3) continue;
    const masks = 1 << n;
    for (let mask = 1; mask < masks; mask++) {
      const picked = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) picked.push(suited[i]);
      for (let useWild = 0; useWild <= wilds.length; useWild++) {
        const len = picked.length + useWild;
        if (len < 3 || len > 13) continue;
        const cards = picked.concat(wilds.slice(0, useWild));
        const v = validateNewSet(cards, wildRank);
        if (v.ok && v.type === "run" && v.arrangements.length) {
          for (const arr of v.arrangements) {
            record({ type: "run", suit: arr.suit, baseValue: arr.baseValue, length: arr.length, cards: arr.cards }, "run", cards);
          }
        }
      }
    }
  }

  // Dedup by sorted card-id signature; keep highest-value version. Tied
  // signatures with different arrangements (different run baseValues) are
  // kept separately so the caller can pick the best wildcard placement.
  const seen = new Map();
  for (const r of out) {
    const repr = r.arrangement.type === "run"
      ? `R|${r.arrangement.suit}|${r.arrangement.baseValue}|${[...r.cardIds].sort().join(",")}`
      : `N|${r.arrangement.rank}|${[...r.cardIds].sort().join(",")}`;
    if (!seen.has(repr)) seen.set(repr, r);
  }
  return [...seen.values()].sort((a, b) => b.valueFreed - a.valueFreed);
}

function enumerateAdditions(hand, table, wildRank) {
  const out = [];
  for (const set of table) {
    for (const h of hand) {
      const v = validateAddition(set, [h], wildRank);
      if (v.ok) {
        const arr = v.type === "number" ? v.arrangement : v.arrangements[0];
        out.push({
          setId: set.id,
          arrangement: arr,
          cardId: h.id,
          valueFreed: pointValue(h, wildRank),
        });
      }
    }
  }
  return out.sort((a, b) => b.valueFreed - a.valueFreed);
}

function enumerateSwaps(hand, table, wildRank) {
  const out = [];
  for (const set of table) {
    for (let pos = 0; pos < set.cards.length; pos++) {
      const target = set.cards[pos];
      if (!target.isWild) continue;
      for (const h of hand) {
        if (isWildcard(h, wildRank)) continue;
        const v = validateSwap(set, pos, h, wildRank);
        if (v.ok) {
          out.push({ setId: set.id, positionIndex: pos, naturalCardId: h.id, takesBack: target.card });
          break;
        }
      }
    }
  }
  return out;
}

// ---------- virtual application (for forecasting after each action) ----------

function virtualState(state, actions) {
  const v = JSON.parse(JSON.stringify(state));
  for (const a of actions) {
    if (a.type === "drawDeck" && v.deck.length) {
      const c = v.deck.shift();
      v.players[v.currentPlayerIndex].hand.push(c);
    } else if (a.type === "drawDiscard" && v.discardPile.length) {
      const c = v.discardPile.pop();
      v.players[v.currentPlayerIndex].hand.push(c);
    } else if (a.type === "play") {
      const me = v.players[v.currentPlayerIndex];
      const ids = a.arrangement.cards.map(c => c.card.id);
      me.hand = me.hand.filter(c => !ids.includes(c.id));
      // Mirror engine's id scheme so any later swap action references the same id.
      v.setIdCounter = (v.setIdCounter || 0) + 1;
      const setId = `s${v.setIdCounter}`;
      a.__resolvedSetId = setId;
      // CRUCIAL: clone the cards array so a later virtualState swap can mutate the
      // virtual set without corrupting the arrangement the engine will receive.
      const set = { id: setId, ownerIndex: v.currentPlayerIndex, type: a.arrangement.type, cards: a.arrangement.cards.map(c => ({ ...c })) };
      if (a.arrangement.type === "number") set.rank = a.arrangement.rank;
      else { set.suit = a.arrangement.suit; set.baseValue = a.arrangement.baseValue; }
      v.table.push(set);
      me.hasOpened = true;
    } else if (a.type === "add") {
      const me = v.players[v.currentPlayerIndex];
      const set = v.table.find(s => s.id === a.setId);
      const ids = a.arrangement.added.map(c => c.card.id);
      me.hand = me.hand.filter(c => !ids.includes(c.id));
      if (set) set.cards.push(...a.arrangement.added.map(c => ({ ...c })));
    } else if (a.type === "swap") {
      const me = v.players[v.currentPlayerIndex];
      const set = v.table.find(s => s.id === a.setId);
      if (set) {
        const target = set.cards[a.positionIndex];
        const idx = me.hand.findIndex(c => c.id === a.naturalCardId);
        if (idx >= 0 && target && target.isWild) {
          const nat = me.hand[idx];
          set.cards[a.positionIndex] = { card: nat, isWild: false, representsRank: target.representsRank, representsSuit: target.representsSuit };
          me.hand.splice(idx, 1);
          me.hand.push(target.card);
        }
      }
    } else if (a.type === "discard") {
      const me = v.players[v.currentPlayerIndex];
      const idx = me.hand.findIndex(c => c.id === a.cardId);
      if (idx >= 0) {
        const c = me.hand[idx];
        me.hand.splice(idx, 1);
        v.discardPile.push(c);
      }
    }
  }
  return v;
}

// ---------- discard chooser ----------

function chooseDiscard(state, difficulty) {
  const me = state.players[state.currentPlayerIndex];
  if (!me.hand.length) return null;
  const wildRank = state.wildcardRank;
  const nonWild = me.hand.filter(c => !isWildcard(c, wildRank));
  const pool = nonWild.length ? nonWild : me.hand;

  if (difficulty === "easy") {
    // Sample uniformly from the bottom-quartile-value cards (no wilds when
    // possible), so the easy CPU still mostly dumps low-value clutter but
    // doesn't always pick the single cheapest card.
    const sorted = pool.slice().sort((a, b) => pointValue(a, wildRank) - pointValue(b, wildRank));
    const cutoff = Math.max(1, Math.ceil(sorted.length * 0.35));
    const slice = sorted.slice(0, cutoff);
    const c = slice[randomInt(slice.length)];
    return { type: "discard", cardId: c.id, narration: `discarded ${cardLabel(c)}` };
  }

  // Whether discarding this card would let the player go out (hand becomes
  // empty). When true, swap-eligibility / hoarding heuristics MUST yield —
  // winning the round trumps everything.
  const goingOut = me.hand.length === 1;

  const candidates = pool.map(card => {
    let badness = -pointValue(card, wildRank); // unloading high value = good (lower badness)
    // Don't gift opponents — penalise discarding a card any opponent could
    // bolt straight onto one of their melds.
    for (const set of state.table) {
      if (set.ownerIndex === state.currentPlayerIndex) continue;
      const trial = validateAddition(set, [card], wildRank);
      if (trial.ok) badness += difficulty === "hard" ? 100 : 60;
    }
    if (difficulty === "hard") {
      // Keeping pairs/adjacent cards is more valuable on hard.
      const sameRank = me.hand.filter(c => c.rank === card.rank).length;
      if (sameRank >= 2) badness += 8;
      const adj = me.hand.some(c => c.suit === card.suit && Math.abs(rankVal(c.rank) - rankVal(card.rank)) === 1);
      if (adj) badness += 4;
    } else { // medium
      const sameRank = me.hand.filter(c => c.rank === card.rank).length;
      if (sameRank >= 2) badness += 5;
    }
    // Don't drop a card we could swap for an already-played wildcard —
    // holding it lets us return the wild to our hand later, which is much
    // more valuable than the card's raw rank.
    if (!goingOut) {
      const swap = findSwappableWildFor(card, state.table, wildRank);
      if (swap) badness += difficulty === "hard" ? 25 : 14;
    }
    // Small randomness so the CPU isn't perfectly predictable.
    if (difficulty === "hard") badness += (randomInt(7) - 3) * 0.3;
    return { card, badness };
  });
  candidates.sort((a, b) => a.badness - b.badness);
  const choice = candidates[0].card;
  return { type: "discard", cardId: choice.id, narration: `discarded ${cardLabel(choice)}` };
}

// ---------- play+add loop ----------

// Score how risky it is to leave a wildcard slot on the table. Higher score
// = safer for the player (opponents can't easily swap). Used by HARD when
// choosing between equivalent plays for the same hand cards.
function safetyScoreForArrangement(arrangement, state, meIdx) {
  if (arrangement.type !== "run") return 0;
  let score = 0;
  for (const slot of arrangement.cards) {
    if (!slot.isWild) continue;
    // Opponents could only swap if they hold the natural — count how many
    // copies are already visible (in my hand, melds, or discard pile). The
    // more visible, the fewer copies opponents can possibly hold.
    const seen = countSeenForRank(slot.representsRank, slot.representsSuit, state, meIdx);
    score += seen * 4;
    // Slight bonus when the represented rank already has a number set on
    // the table (rank essentially "spoken for").
    if (state.table.some(s => s.type === "number" && s.rank === slot.representsRank)) score += 6;
  }
  return score;
}

// Pick the best play out of a set of candidates that all freed the same hand
// cards. Adds wildcard discipline (fewer wilds = better) and run-safety
// scoring for HARD.
function chooseBestPlay(candidates, state, difficulty) {
  const meIdx = state.currentPlayerIndex;
  return candidates.slice().sort((a, b) => {
    const aw = a.wildCount;
    const bw = b.wildCount;
    // Wildcard discipline: every wild used in a play that doesn't need it
    // costs ~10 effective points (15-point card stranded on the table).
    let aScore = a.valueFreed - aw * 10;
    let bScore = b.valueFreed - bw * 10;
    if (difficulty === "hard") {
      aScore += safetyScoreForArrangement(a.arrangement, state, meIdx);
      bScore += safetyScoreForArrangement(b.arrangement, state, meIdx);
      // Prefer runs over number sets when tied — runs accept future adds.
      if (a.kind === "run") aScore += 2;
      if (b.kind === "run") bScore += 2;
    }
    return bScore - aScore;
  })[0];
}

function applyPlayAndAddLoop(initialState, actions, difficulty) {
  const wildRank = initialState.wildcardRank;
  let safety = 12;
  while (safety-- > 0) {
    const v = virtualState(initialState, actions);
    const me = v.players[v.currentPlayerIndex];
    if (me.hand.length <= 1) break; // need ≥1 to discard

    const plays = enumerateNewSets(me.hand, wildRank, v.table).filter(p => me.hand.length - p.cardIds.length >= 1);
    if (plays.length) {
      // Group by hand-card signature so wildcard-discipline only competes
      // among plays that use the same physical cards.
      const groups = new Map();
      for (const p of plays) {
        const sig = [...p.cardIds].sort().join("|");
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig).push(p);
      }
      // Pick the best representative per group, then sort groups by value.
      const reps = [];
      for (const g of groups.values()) reps.push(chooseBestPlay(g, v, difficulty));
      reps.sort((a, b) => b.valueFreed - a.valueFreed);
      // Wildcard-hoard rule: never play a set whose majority is wildcards
      // unless that's literally all we have (e.g., 3 wilds + 1 natural).
      let chosen = reps.find(p => p.wildCount * 2 <= p.cardIds.length) || reps[0];
      // Wildcard rationing for HARD: if we hold 3+ wildcards in total AND
      // the chosen play would dump 2+ of them, prefer a less wild-heavy
      // alternative even if it frees fewer points.
      if (difficulty === "hard") {
        const wildsInHand = me.hand.filter(c => isWildcard(c, wildRank)).length;
        if (wildsInHand >= 3 && chosen.wildCount >= 2) {
          const leaner = reps.find(p => p.wildCount < chosen.wildCount);
          if (leaner) chosen = leaner;
        }
      }
      actions.push({ type: "play", arrangement: chosen.arrangement, narration: describePlay(chosen.arrangement) });
      continue;
    }

    if (me.hasOpened) {
      const adds = enumerateAdditions(me.hand, v.table, wildRank).filter(a => me.hand.length - 1 >= 1);
      if (adds.length) {
        const chosen = adds[0];
        const card = me.hand.find(c => c.id === chosen.cardId);
        actions.push({
          type: "add",
          setId: chosen.setId,
          arrangement: chosen.arrangement,
          narration: `added ${cardLabel(card)} to a set`,
        });
        continue;
      }
    }
    break;
  }
}

function describePlay(arrangement) {
  if (arrangement.type === "number") {
    const n = arrangement.cards.length;
    return `played ${arrangement.rank}-${arrangement.rank}-${arrangement.rank}${n === 4 ? `-${arrangement.rank}` : ""}`;
  }
  const seq = arrangement.cards.map(c => c.isWild ? `W=${c.representsRank}` : c.representsRank).join("-");
  return `played ${seq} of ${SUIT_GLYPH[arrangement.suit]}`;
}

// ---------- main entry ----------

export function planTurn(state, difficulty) {
  const actions = [];
  const wildRank = state.wildcardRank;
  const isDealerOpening = state.dealerOpeningPending && state.currentPlayerIndex === state.dealerIndex;

  if (!isDealerOpening) {
    const top = topOfDiscard(state);
    let takeDiscard = false;
    if (top) {
      const me = state.players[state.currentPlayerIndex];
      if (isWildcard(top, wildRank) && difficulty !== "easy") {
        takeDiscard = true;
      } else if (difficulty !== "easy") {
        // Could this card swap an already-placed wildcard back into our
        // hand? If so it's worth ~15 points — almost always grab it.
        const swap = findSwappableWildFor(top, state.table, wildRank);
        if (swap && me.hasOpened) takeDiscard = true;
        if (!takeDiscard) {
          const before = enumerateNewSets(me.hand, wildRank, state.table).length;
          const after = enumerateNewSets([...me.hand, top], wildRank, state.table).length;
          if (after > before) takeDiscard = true;
        }
        if (!takeDiscard && difficulty === "hard") {
          const sameRank = me.hand.filter(c => c.rank === top.rank).length;
          if (sameRank >= 1) takeDiscard = true;
        }
      }
    }
    if (takeDiscard) {
      actions.push({ type: "drawDiscard", narration: `picked up ${cardLabel(top)} from the discard pile` });
    } else {
      actions.push({ type: "drawDeck", narration: "drew from the deck" });
    }
  }

  if (difficulty === "easy" && randomInt(10) < 7) {
    const d = chooseDiscard(virtualState(state, actions), "easy");
    if (d) actions.push(d);
    return actions;
  }

  applyPlayAndAddLoop(state, actions, difficulty);

  if (difficulty !== "easy") {
    const v = virtualState(state, actions);
    const me = v.players[v.currentPlayerIndex];
    if (me.hasOpened) {
      const swaps = enumerateSwaps(me.hand, v.table, wildRank);
      if (swaps.length) {
        const s = swaps[0];
        actions.push({
          type: "swap",
          setId: s.setId,
          positionIndex: s.positionIndex,
          naturalCardId: s.naturalCardId,
          narration: `swapped a ${cardLabel(s.takesBack)} back into hand`,
        });
      }
    }
  }

  const d = chooseDiscard(virtualState(state, actions), difficulty);
  if (d) actions.push(d);
  return actions;
}

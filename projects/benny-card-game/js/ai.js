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

// ---------- enumeration ----------

function enumerateNewSets(hand, wildRank, table = []) {
  const out = [];
  const wilds = hand.filter(c => isWildcard(c, wildRank));
  const byRank = {};
  for (const c of hand) (byRank[c.rank] = byRank[c.rank] || []).push(c);
  // Ranks already represented by a number set on the table — can't start a parallel one.
  const tableRanks = new Set(table.filter(s => s.type === "number").map(s => s.rank));

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
          out.push({
            arrangement: { type: "number", rank: v.rank, cards: v.cards },
            kind: "number",
            cardIds: cards.map(c => c.id),
            valueFreed: cards.reduce((s, c) => s + pointValue(c, wildRank), 0),
          });
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
          const arr = v.arrangements[0];
          out.push({
            arrangement: { type: "run", suit: arr.suit, baseValue: arr.baseValue, length: arr.length, cards: arr.cards },
            kind: "run",
            cardIds: cards.map(c => c.id),
            valueFreed: cards.reduce((s, c) => s + pointValue(c, wildRank), 0),
          });
        }
      }
    }
  }

  // Dedup by sorted card-id signature; keep highest-value version.
  const seen = new Map();
  for (const r of out) {
    const sig = [...r.cardIds].sort().join("|");
    const existing = seen.get(sig);
    if (!existing || r.valueFreed > existing.valueFreed) seen.set(sig, r);
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
    const c = pool[randomInt(pool.length)];
    return { type: "discard", cardId: c.id, narration: `discarded ${cardLabel(c)}` };
  }

  const candidates = pool.map(card => {
    let badness = -pointValue(card, wildRank); // unloading high value = good (lower badness)
    if (difficulty === "hard") {
      for (const set of state.table) {
        if (set.ownerIndex === state.currentPlayerIndex) continue;
        const trial = validateAddition(set, [card], wildRank);
        if (trial.ok) badness += 100;
      }
      const sameRank = me.hand.filter(c => c.rank === card.rank).length;
      if (sameRank >= 2) badness += 8;
      const adj = me.hand.some(c => c.suit === card.suit && Math.abs(rankVal(c.rank) - rankVal(card.rank)) === 1);
      if (adj) badness += 4;
    } else { // medium
      const sameRank = me.hand.filter(c => c.rank === card.rank).length;
      if (sameRank >= 2) badness += 5;
    }
    return { card, badness };
  });
  candidates.sort((a, b) => a.badness - b.badness);
  const choice = candidates[0].card;
  return { type: "discard", cardId: choice.id, narration: `discarded ${cardLabel(choice)}` };
}

// ---------- play+add loop ----------

function applyPlayAndAddLoop(initialState, actions, difficulty) {
  const wildRank = initialState.wildcardRank;
  let safety = 12;
  while (safety-- > 0) {
    const v = virtualState(initialState, actions);
    const me = v.players[v.currentPlayerIndex];
    if (me.hand.length <= 1) break; // need ≥1 to discard

    const plays = enumerateNewSets(me.hand, wildRank, v.table).filter(p => me.hand.length - p.cardIds.length >= 1);
    if (plays.length) {
      let chosen;
      if (difficulty === "hard") chosen = plays.find(p => p.kind === "run") || plays[0];
      else chosen = plays[0];
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
        const before = enumerateNewSets(me.hand, wildRank, state.table).length;
        const after = enumerateNewSets([...me.hand, top], wildRank, state.table).length;
        if (after > before) takeDiscard = true;
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

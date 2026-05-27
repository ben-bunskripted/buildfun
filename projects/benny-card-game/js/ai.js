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

// ---------- Opponent modelling ----------
//
// "Threat" is a 0-200 score capturing how close an opponent looks to going
// out. Hand size dominates; opened players who have melds are deadlier still.
// Used to scale defensive penalties in chooseDiscard, and to flip HARD out
// of long-game wildcard hoarding mode when the round is about to crash.
function opponentThreat(state, oppIdx) {
  const opp = state.players[oppIdx];
  let score = 0;
  if (opp.hand.length <= 1) score += 120;
  else if (opp.hand.length === 2) score += 80;
  else if (opp.hand.length === 3) score += 45;
  else if (opp.hand.length === 4) score += 22;
  else if (opp.hand.length === 5) score += 10;
  if (opp.hasOpened) score += 25;
  const oppMelds = state.table.filter(s => s.ownerIndex === oppIdx);
  score += oppMelds.length * 8;
  // Runs accept future adds — extra dangerous if the opponent owns one.
  score += oppMelds.filter(s => s.type === "run").length * 6;
  return score;
}

function maxOpponentThreat(state) {
  let max = 0;
  for (let i = 0; i < state.players.length; i++) {
    if (i === state.currentPlayerIndex) continue;
    const t = opponentThreat(state, i);
    if (t > max) max = t;
  }
  return max;
}

// Ranks an opponent has discarded at least once this round. Anything NOT
// in this set is a rank they've shown no willingness to part with — could
// be a tell that they're collecting it. Skip the heuristic for opponents
// with <2 discards (insufficient signal).
function opponentDiscardedRanks(state, oppIdx) {
  const out = new Set();
  let count = 0;
  for (const d of (state.matchEvents && state.matchEvents.discards) || []) {
    if (d.playerIdx !== oppIdx) continue;
    out.add(d.rank);
    count += 1;
  }
  return { ranks: out, count };
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

  // Number sets — naturals of one rank + 0..k wildcards, total >= 3.
  for (const rank of Object.keys(byRank)) {
    if (rank === wildRank) continue;
    if (tableRanks.has(rank)) continue;
    const naturals = byRank[rank];
    for (let useNat = naturals.length; useNat >= 1; useNat--) {
      for (let useWild = 0; useWild <= wilds.length; useWild++) {
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

  if (difficulty === "easy") {
    // Sample uniformly from the bottom-quartile-value cards (no wilds when
    // possible), so the easy CPU still mostly dumps low-value clutter but
    // doesn't always pick the single cheapest card.
    const pool = nonWild.length ? nonWild : me.hand;
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

  // Opponent modelling — read once per discard call.
  const threat = maxOpponentThreat(state);
  const endgame = threat >= 80;          // someone has ≤2 cards left
  // Threat scaling: a 1.0x multiplier at default, ramping up to ~2.0x in
  // endgame so the CPU stops gifting adds even at the cost of higher hand
  // value remaining.
  const threatMult = 1 + Math.min(1, threat / 100);

  // Wildcards are normally never discarded while we hold a natural — they're
  // our go-out fuel. But once an opponent is about to go out (endgame), a wild
  // we couldn't meld is just 15 points we'll be caught holding, so make it
  // eligible to discard. The gift penalty below still steers us away from
  // handing a wild to an opponent whose meld it would extend.
  const pool = (nonWild.length && !endgame) ? nonWild : me.hand;

  // Per-opponent rank profiles (HARD only). A rank an opponent has never
  // discarded — when they've had a chance to — is suspicious.
  const oppProfiles = difficulty === "hard"
    ? state.players.map((_, i) => i === state.currentPlayerIndex ? null : opponentDiscardedRanks(state, i))
    : null;

  const candidates = pool.map(card => {
    let badness = -pointValue(card, wildRank); // unloading high value = good (lower badness)
    // Don't gift opponents — penalise discarding a card any opponent could
    // bolt straight onto one of their melds. Scale by the highest-threat
    // opponent so endgame play stops gifting cards entirely.
    for (let oi = 0; oi < state.players.length; oi++) {
      if (oi === state.currentPlayerIndex) continue;
      const opp = state.players[oi];
      for (const set of state.table) {
        if (set.ownerIndex !== oi) continue;
        const trial = validateAddition(set, [card], wildRank);
        if (!trial.ok) continue;
        const base = difficulty === "hard" ? 100 : 60;
        // Weight the gift penalty by THIS opponent's threat, not the max —
        // gifting a leader is worse than gifting a struggler.
        const oppMult = 1 + Math.min(1, opponentThreat(state, oi) / 100);
        badness += base * oppMult;
      }
    }
    if (difficulty === "hard") {
      // Keeping pairs/adjacent cards is more valuable on hard.
      const sameRank = me.hand.filter(c => c.rank === card.rank).length;
      if (sameRank >= 2) badness += 8;
      const adj = me.hand.some(c => c.suit === card.suit && Math.abs(rankVal(c.rank) - rankVal(card.rank)) === 1);
      if (adj) badness += 4;
      // Hoarded-rank avoidance: only meaningful once the opponent has done
      // enough discarding to give a real signal (≥4 of their own), and even
      // then only a light nudge — we don't want it to override the basic
      // "shed high-value cards" rule unless threat is genuine.
      if (!goingOut && oppProfiles) {
        for (let oi = 0; oi < state.players.length; oi++) {
          const prof = oppProfiles[oi];
          if (!prof || prof.count < 4) continue;
          if (!prof.ranks.has(card.rank)) badness += 6 * threatMult;
        }
      }
    } else { // medium
      const sameRank = me.hand.filter(c => c.rank === card.rank).length;
      if (sameRank >= 2) badness += 5;
    }
    // Don't drop a card we could swap for an already-played wildcard —
    // holding it lets us return the wild to our hand later, which is much
    // more valuable than the card's raw rank. Endgame disables the hoard
    // since holding a 15-point wild is worse than getting caught with it.
    if (!goingOut && !endgame) {
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

// Minimum natural value a play must free to justify stranding ONE wildcard on
// the table (eased as an opponent nears going out — see the loop). A melded
// wildcard is ~15 dead points plus our best go-out fuel, so we don't spend one
// to lay down trivial cards.
const WILD_KEEP_VALUE = 12;

// Natural (non-wild) point value a play sheds. `valueFreed` counts each wild as
// 15, so subtract those back out.
function naturalValueFreed(play) {
  return play.valueFreed - play.wildCount * 15;
}

// Rough "closeness to forming melds" for a set of hand cards: rewards duplicate
// ranks (number-set seeds), touching / one-gap same-suit cards (run seeds), and
// retained wildcards (which fill any blank). Used to prefer opens that leave the
// hand best placed to go out in one move (shape-aware opening).
function handShapeScore(cards, wildRank) {
  const naturals = cards.filter(c => !isWildcard(c, wildRank));
  let score = (cards.length - naturals.length) * 4; // retained wildcards are gold

  const byRank = {};
  for (const c of naturals) byRank[c.rank] = (byRank[c.rank] || 0) + 1;
  for (const r of Object.keys(byRank)) if (byRank[r] >= 2) score += (byRank[r] - 1) * 3;

  const bySuit = {};
  for (const c of naturals) (bySuit[c.suit] = bySuit[c.suit] || []).push(rankVal(c.rank));
  for (const suit of Object.keys(bySuit)) {
    const vals = [...new Set(bySuit[suit])].sort((a, b) => a - b);
    for (let i = 0; i < vals.length - 1; i++) {
      const gap = vals[i + 1] - vals[i];
      if (gap === 1) score += 3;      // touching → strong run seed
      else if (gap === 2) score += 1; // one-gap → a wildcard can bridge it
    }
  }
  return score;
}

// `shed` (go-out mode): drop the positional heuristics that only matter when
// the round continues — wildcard hoarding, wild rationing, swap preservation —
// and just shed as many cards as possible. Used by planGoOut: emptying the
// hand wins the round outright, so nothing else is worth optimising for.
function applyPlayAndAddLoop(initialState, actions, difficulty, shed = false) {
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
      // Go-out mode: ignore wildcard discipline entirely and play whatever
      // sheds the most cards — emptying the hand wins the round.
      if (shed) {
        reps.sort((a, b) => (b.cardIds.length - a.cardIds.length) || (b.valueFreed - a.valueFreed));
        actions.push({ type: "play", arrangement: reps[0].arrangement, narration: describePlay(reps[0].arrangement) });
        continue;
      }
      // Not going out this turn — decide which set (if any) is worth laying.
      const threat = maxOpponentThreat(v);
      const endgame = threat >= 80;
      let chosen = null;

      if (difficulty === "easy") {
        // Easy stays simple: least wild-heavy option, else the top play.
        chosen = reps.find(p => p.wildCount * 2 <= p.cardIds.length) || reps[0];
      } else if (endgame) {
        // An opponent is about to go out: shed the most cards (and value) we
        // can — wildcards included — since minimising what we're caught
        // holding beats hoarding flexibility for a round that's ending now.
        reps.sort((a, b) => (b.cardIds.length - a.cardIds.length) || (b.valueFreed - a.valueFreed));
        chosen = reps[0];
      } else {
        // #1 Hard floor: never lay a set that's majority wildcards — burying
        // 2-3 bennies to put down a card or two strands 15-point cards and our
        // best go-out fuel.
        let cands = reps.filter(p => p.wildCount * 2 <= p.cardIds.length);
        // #2 Wildcards are keep-cards (HARD): only spend a wild on a set that
        // frees enough real (natural) value to justify stranding it. The bar
        // eases as an opponent closes in (threat) so we loosen up rather than
        // hoard into a loss; wild-free plays always qualify.
        if (difficulty === "hard") {
          const bar = WILD_KEEP_VALUE * (1 - Math.min(1, threat / 100));
          cands = cands.filter(p => p.wildCount === 0 || naturalValueFreed(p) >= p.wildCount * bar);
        }
        if (cands.length) {
          if (difficulty === "hard") {
            // #3 Shape-aware open: among worthwhile plays, prefer the one that
            // frees good value AND leaves the best-shaped remaining hand —
            // pairs and adjacent-suited cards that can still grow into a
            // one-shot go-out. Runs are nudged since they keep taking adds.
            let best = -Infinity;
            for (const p of cands) {
              const ids = new Set(p.cardIds);
              const remaining = me.hand.filter(c => !ids.has(c.id));
              const score = p.valueFreed + handShapeScore(remaining, wildRank) + (p.kind === "run" ? 2 : 0);
              if (score > best) { best = score; chosen = p; }
            }
          } else {
            chosen = cands[0]; // medium: highest-value non-wild-heavy play
          }
        }
        // cands empty -> chosen stays null: hold the wilds/shape and develop.
      }

      if (chosen) {
        actions.push({ type: "play", arrangement: chosen.arrangement, narration: describePlay(chosen.arrangement) });
        continue;
      }
      // Nothing worth opening with — fall through to adds (if opened), then discard.
    }

    if (me.hasOpened) {
      let adds = enumerateAdditions(me.hand, v.table, wildRank).filter(a => me.hand.length - 1 >= 1);
      // Don't burn a natural card padding a meld when that same card could
      // instead swap a wildcard back out of a set — recovering a 15-point
      // wild to reuse beats a plain add. Prefer adds that DON'T have a swap
      // alternative; if every available add could be a swap, stop here and
      // let the swap step (in planAfterDraw) take the benny back. Disabled in
      // the endgame: when an opponent is about to go out, shedding a card
      // (adds shrink the hand; swaps don't) matters more than the wild.
      if (adds.length && difficulty !== "easy" && !shed && maxOpponentThreat(v) < 80) {
        const nonSwap = adds.filter(a => !findSwappableWildFor(me.hand.find(c => c.id === a.cardId), v.table, wildRank));
        if (nonSwap.length) adds = nonSwap;
        else break;
      }
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
    return `played ${Array(n).fill(arrangement.rank).join("-")}`;
  }
  const seq = arrangement.cards.map(c => c.isWild ? `W=${c.representsRank}` : c.representsRank).join("-");
  return `played ${seq} of ${SUIT_GLYPH[arrangement.suit]}`;
}

// ---------- main entry ----------

// Run the play/add loop, then (non-easy) one swap, then choose a discard.
// `actions` already holds the chosen draw action (or is empty on the dealer's
// opening turn). Mutates and returns `actions`.
function planAfterDraw(state, actions, difficulty) {
  const wildRank = state.wildcardRank;
  applyPlayAndAddLoop(state, actions, difficulty);

  if (difficulty !== "easy") {
    // Take back every swappable benny, not just one. Each swap removes a
    // natural from hand and returns a wildcard (which enumerateSwaps skips),
    // so the candidate pool strictly shrinks and the loop terminates.
    let safety = 12;
    while (safety-- > 0) {
      const v = virtualState(state, actions);
      const me = v.players[v.currentPlayerIndex];
      if (!me.hasOpened) break;
      const swaps = enumerateSwaps(me.hand, v.table, wildRank);
      if (!swaps.length) break;
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

  const d = chooseDiscard(virtualState(state, actions), difficulty);
  if (d) actions.push(d);
  return actions;
}

// Reasons (medium/hard) the top of the discard beats a blind deck draw: it's a
// wildcard, it swaps a placed wild back into hand, it opens a new set, or
// (hard) we already hold a copy of its rank.
function wantsDiscardTop(state, top, difficulty) {
  const wildRank = state.wildcardRank;
  const me = state.players[state.currentPlayerIndex];
  if (isWildcard(top, wildRank)) return true;
  const swap = findSwappableWildFor(top, state.table, wildRank);
  if (swap && me.hasOpened) return true;
  // Extending a meld already on the table is just as good a reason to pick up
  // as opening a new set. Only possible once we've opened (can't add before).
  if (me.hasOpened && enumerateAdditions([top], state.table, wildRank).length) return true;
  const before = enumerateNewSets(me.hand, wildRank, state.table).length;
  const after = enumerateNewSets([...me.hand, top], wildRank, state.table).length;
  if (after > before) return true;
  if (difficulty === "hard") {
    const sameRank = me.hand.filter(c => c.rank === top.rank).length;
    if (sameRank >= 1) return true;
  }
  return false;
}

// True if `cardId` ends up on the table this turn (played, added, or swapped
// in) rather than left in hand.
function cardMelded(plan, cardId) {
  for (const a of plan) {
    if (a.type === "play" && a.arrangement.cards.some(c => c.card && c.card.id === cardId)) return true;
    if (a.type === "add" && a.arrangement.added && a.arrangement.added.some(c => c.card && c.card.id === cardId)) return true;
    if (a.type === "swap" && a.naturalCardId === cardId) return true;
  }
  return false;
}

// A discard-pile pickup is pointless ("dead even") when we don't actually meld
// the card and then discard a card of the SAME RANK we already held — we'd just
// be trading one rank-R card for an identical one (e.g. take K♥, bin K♠). The
// literal same-card bounce is the special case where the discard IS the top.
function pickupIsDeadEnd(state, top, plan) {
  if (cardMelded(plan, top.id)) return false;
  const last = plan[plan.length - 1];
  if (!last || last.type !== "discard") return false;   // went out / no discard
  if (last.cardId === top.id) return true;              // picked up, binned same card
  const me = state.players[state.currentPlayerIndex];
  const discarded = me.hand.find(c => c.id === last.cardId);
  return !!discarded && discarded.rank === top.rank;
}

function planGoesOut(state, plan) {
  const v = virtualState(state, plan);
  return v.players[v.currentPlayerIndex].hand.length === 0;
}

// Seek a line that empties the hand this turn (winning the round). Sheds as
// many cards as possible via plays/adds — without the positional heuristics
// that only matter when the round continues — then checks whether the forecast
// goes out. Swaps are skipped: a 1-for-1 swap never shrinks the hand, so it
// can't contribute to going out. `draw` is the opening draw action, or null on
// the dealer's no-draw opening turn. Returns the winning plan, or null.
function planGoOut(state, draw, difficulty) {
  const actions = draw ? [draw] : [];
  applyPlayAndAddLoop(state, actions, difficulty, true);
  const d = chooseDiscard(virtualState(state, actions), difficulty);
  if (d) actions.push(d);
  return planGoesOut(state, actions) ? actions : null;
}

export function planTurn(state, difficulty) {
  const isDealerOpening = state.dealerOpeningPending && state.currentPlayerIndex === state.dealerIndex;
  const deckDraw = () => ({ type: "drawDeck", narration: "drew from the deck" });

  // Easy never mines the discard pile, and 70% of the time just draws and dumps.
  if (difficulty === "easy") {
    const actions = isDealerOpening ? [] : [deckDraw()];
    if (randomInt(10) < 7) {
      const d = chooseDiscard(virtualState(state, actions), "easy");
      if (d) actions.push(d);
      return actions;
    }
    return planAfterDraw(state, actions, "easy");
  }

  // Going out wins the round, so it dominates every positional heuristic
  // (wildcard hoarding, swap preservation, defensive discards). Before the
  // normal heuristic planning, look for a line that empties the hand this turn.
  // Prefer one built on the discard top (public info) over a peeked deck draw.
  if (!isDealerOpening) {
    const top = topOfDiscard(state);
    if (top) {
      const g = planGoOut(state, { type: "drawDiscard", narration: `picked up ${cardLabel(top)} from the discard pile` }, difficulty);
      if (g) return g;
    }
    const g = planGoOut(state, deckDraw(), difficulty);
    if (g) return g;
  } else {
    const g = planGoOut(state, null, difficulty);
    if (g) return g;
  }

  // Dealer's opening turn: no draw — straight to playing + discarding.
  if (isDealerOpening) return planAfterDraw(state, [], difficulty);

  // Consider the discard top, but only commit to it if the full forecast
  // actually USES the card. Picking a card up and discarding the same card on
  // the same turn is a wasted move — fall back to a deck draw. (A line that
  // goes out is always kept, even if the leftover happens to be the top card.)
  const top = topOfDiscard(state);
  if (top && wantsDiscardTop(state, top, difficulty)) {
    const takePlan = planAfterDraw(
      state,
      [{ type: "drawDiscard", narration: `picked up ${cardLabel(top)} from the discard pile` }],
      difficulty,
    );
    if (planGoesOut(state, takePlan) || !pickupIsDeadEnd(state, top, takePlan)) return takePlan;
  }
  return planAfterDraw(state, [deckDraw()], difficulty);
}

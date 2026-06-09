// Sh!thead CPU. planTurn(state) returns a single action for the current player.
// Three tiers:
//   easy   — plays a random legal card, one at a time.
//   normal — sheds the lowest legal card, dumps its duplicates, completes a
//            four-of-a-kind to burn, and hoards its powers (2/10/joker) for when
//            it is otherwise stuck.
//   hard   — normal, plus two refinements that win measurably more games in
//            self-play: on a high pile (a face card or ace showing) it resets
//            with a cheap 2 rather than spending a scarce high card; and in the
//            endgame (deck spent) it plays its Aces one at a time, keeping one as
//            a universal always-legal escape instead of dumping the pair.
//
// Things that were tried and did NOT help (kept out on the evidence): pressuring
// opponents off card-counting memory or their visible face-up row — even forcing
// a guaranteed pickup with perfect information was neutral, because the spots you
// can force are ones you were already winning, and acting on partial information
// disorders your own hand for less than it gains.

import { value, requirement, canPlayRank, isJokerAnswer } from "./rules.js";
import { currentZone } from "./game.js";
import { pickRandom, randomInt } from "./rng.js";

// Ranks the CPU keeps in reserve rather than leading with: the always-playable
// powers (2, 10) plus the joker, which it would rather fire when truly stuck.
const POWER = new Set(["2", "10", "JK"]);

function countsByRank(cards) {
  const m = new Map();
  for (const c of cards) m.set(c.rank, (m.get(c.rank) || []).concat(c));
  return m;
}

export function planTurn(state) {
  const p = state.players[state.current];
  const zone = currentZone(p);
  if (!zone) return { type: "pickup", playerId: p.id }; // shouldn't happen

  // Under a joker attack: answer with a 3 (or another joker) if one is to hand,
  // otherwise eat the pile. Down to blind face-down cards, flip one — it deflects
  // if it lands a 3/joker, and is scooped up with the pile otherwise.
  if (state.jokerAttack) {
    if (zone === "faceDown") {
      const card = pickRandom(p.faceDown);
      return { type: "play", playerId: p.id, source: "faceDown", cardIds: [card.id] };
    }
    const answer = p[zone].find((c) => isJokerAnswer(c.rank, state.options));
    if (answer) return playAction(p, zone, [answer]);
    return { type: "pickup", playerId: p.id };
  }

  // Blind face-down: nothing to reason about — flip a random one.
  if (zone === "faceDown") {
    const card = pickRandom(p.faceDown);
    return { type: "play", playerId: p.id, source: "faceDown", cardIds: [card.id] };
  }

  // Hand empty with face-up cards left: scoop them into hand (up to 3), then
  // play from hand on the next turn like everyone else.
  if (zone === "faceUp") {
    return { type: "takeFaceUp", playerId: p.id, cardIds: p.faceUp.slice(0, 3).map((c) => c.id) };
  }

  const cards = p[zone];
  const opts = state.options;
  const req = requirement(state.pile, opts);
  const legal = cards.filter((c) => canPlayRank(c.rank, req, opts));
  if (legal.length === 0) return { type: "pickup", playerId: p.id };

  const diff = p.difficulty || "normal";
  const byRank = countsByRank(legal);

  if (diff === "easy") {
    // Weak but progress-making: usually dump the single lowest legal card (this
    // guarantees the high-card holder keeps shedding, so games end). A minority of
    // the time it plays a random legal card — the "mistakes" that make it easy.
    if (legal.length > 1 && randomInt(4) === 0) {
      return playAction(p, zone, [pickRandom(legal)]);
    }
    const lowest = legal.slice().sort((a, b) => value(a.rank) - value(b.rank))[0];
    return playAction(p, zone, [lowest]);
  }

  // ----- normal / hard ranking of candidate ranks -----
  const ranks = [...byRank.keys()];

  // Burn the pile whenever we can complete a four-of-a-kind — it clears the
  // board and (with replayOnBurn) hands us another turn, one of the strongest
  // plays in the game. Worth taking for both normal and hard, ahead of an
  // ordinary shed.
  const burn = burnPlay(state, byRank, opts);
  if (burn) return playAction(p, zone, burn);

  if (diff === "hard" && req.kind === "min" && req.value >= value("J") && byRank.has("2")) {
    // A face card or ace is showing. Rather than spend a scarce high climber
    // (or a 10) to clear it, reset the pile with a single 2: a 2 is our most
    // disposable card (always playable, so never stranded), and keeping our
    // J/Q/K/A and 10s in reserve wins materially more games in self-play.
    return playAction(p, zone, byRank.get("2").slice(0, 1));
  }

  // Prefer the lowest non-power rank; dump all duplicates of it. One endgame
  // exception: once the deck is spent we play our Aces one at a time. An Ace is
  // the only non-power card legal on ANY pile (nothing outranks it), so a held
  // Ace is a permanent "never forced to pick up" escape — dumping our last pair
  // together throws that insurance away, and self-play confirms keeping one in
  // reserve wins more endgames.
  const nonPower = ranks.filter((r) => !POWER.has(r)).sort((a, b) => value(a) - value(b));
  if (nonPower.length) {
    const r = nonPower[0];
    const cards = byRank.get(r);
    if (diff === "hard" && state.deck.length === 0 && r === "A" && cards.length > 1) {
      return playAction(p, zone, cards.slice(0, 1));
    }
    return playAction(p, zone, cards);
  }

  // Only powers are legal. On a fat pile, fire a joker to dump it on the next
  // player (or torch it with a 10); on a thin pile, reset cheaply with a 2 and
  // hoard the joker for a juicier moment.
  const fat = state.pile.length >= 4;
  const order = fat ? ["JK", "10", "2"] : ["2", "10", "JK"];
  for (const r of order) {
    if (byRank.has(r)) return playAction(p, zone, byRank.get(r).slice(0, 1));
  }
  return playAction(p, zone, byRank.get(ranks[0]).slice(0, 1));
}

// A play that burns the pile this turn by completing a four-of-a-kind: either
// topping off a run already on the pile, or laying four of one rank we hold at
// once. Returns the cards to play, or null. Powers are skipped — a 2/10/joker
// is worth more used for its own effect than spent burning.
function burnPlay(state, byRank, opts) {
  const top = state.pile[state.pile.length - 1];
  if (top && opts.fourKindAcrossTurns && !POWER.has(top.rank)) {
    const sameOnTop = countTopSame(state.pile);
    if (sameOnTop >= 1 && sameOnTop < 4 && byRank.has(top.rank)) {
      return byRank.get(top.rank);            // our copies complete the four → burn
    }
  }
  let best = null;
  for (const [r, cs] of byRank) {
    if (POWER.has(r)) continue;
    if (cs.length >= 4 && (best === null || value(r) < value(best))) best = r;
  }
  return best === null ? null : byRank.get(best);
}

function countTopSame(pile) {
  if (!pile.length) return 0;
  const r = pile[pile.length - 1].rank;
  let n = 0;
  for (let i = pile.length - 1; i >= 0 && pile[i].rank === r; i--) n++;
  return n;
}

function playAction(p, zone, cards) {
  return { type: "play", playerId: p.id, source: zone, cardIds: cards.map((c) => c.id) };
}

// Pre-game swap heuristic: pull the strongest cards onto the table (face-up), so
// the CPU starts with low cards in hand to shed and power on the table for later.
export function planSwaps(player) {
  const swaps = [];
  // Rank desirability for the FACE-UP row (kept for the endgame): powers highest.
  const desire = (c) => (c.rank === "2" || c.rank === "10" ? 100 : value(c.rank));
  let hand = player.hand.map((c) => ({ ...c }));
  let faceUp = player.faceUp.map((c) => ({ ...c }));
  let changed = true, guard = 0;
  while (changed && guard++ < 12) {
    changed = false;
    // Best card in hand we'd rather have face-up, worst card face-up we'd swap out.
    let bh = -1, bhv = -Infinity;
    hand.forEach((c, i) => { if (desire(c) > bhv) { bhv = desire(c); bh = i; } });
    let wf = -1, wfv = Infinity;
    faceUp.forEach((c, i) => { if (desire(c) < wfv) { wfv = desire(c); wf = i; } });
    if (bh >= 0 && wf >= 0 && bhv > wfv) {
      swaps.push({ handId: hand[bh].id, faceUpId: faceUp[wf].id });
      const t = hand[bh]; hand[bh] = faceUp[wf]; faceUp[wf] = t;
      changed = true;
    }
  }
  return swaps;
}

export { POWER, randomInt };

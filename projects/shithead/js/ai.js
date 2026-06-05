// Sh!thead CPU. planTurn(state) returns a single action for the current player.
// Three tiers:
//   easy   — plays a random legal card, one at a time.
//   normal — sheds the lowest legal card, hoards power cards (2/10) for when stuck.
//   hard   — normal + completes 4-of-a-kinds, burns fat/dangerous piles, dumps
//            duplicates, and is stingier with its power cards.

import { value, requirement, canPlayRank } from "./rules.js";
import { currentZone } from "./game.js";
import { pickRandom, randomInt } from "./rng.js";

const POWER = new Set(["2", "10"]);

function countsByRank(cards) {
  const m = new Map();
  for (const c of cards) m.set(c.rank, (m.get(c.rank) || []).concat(c));
  return m;
}

export function planTurn(state) {
  const p = state.players[state.current];
  const zone = currentZone(p);
  if (!zone) return { type: "pickup", playerId: p.id }; // shouldn't happen

  // Blind face-down: nothing to reason about — flip a random one.
  if (zone === "faceDown") {
    const card = pickRandom(p.faceDown);
    return { type: "play", playerId: p.id, source: "faceDown", cardIds: [card.id] };
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

  if (diff === "hard") {
    // 1) Complete a four-of-a-kind already building on the pile → instant burn.
    const top = state.pile[state.pile.length - 1];
    if (top && opts.fourKindAcrossTurns) {
      const sameOnTop = countTopSame(state.pile);
      if (sameOnTop >= 1 && byRank.has(top.rank)) {
        const need = 4 - sameOnTop;
        const have = byRank.get(top.rank);
        if (have.length >= need && need > 0) {
          return playAction(p, zone, have.slice(0, Math.min(have.length, 4)));
        }
      }
    }
    // 2) Burn a fat or high pile we'd rather not hand over, if we hold a 10.
    const dangerous = state.pile.length >= 5 || (top && value(top.rank) >= 12);
    if (dangerous && byRank.has("10")) {
      return playAction(p, zone, byRank.get("10").slice(0, 1));
    }
  }

  // Prefer the lowest non-power rank; dump all duplicates of it.
  const nonPower = ranks.filter((r) => !POWER.has(r)).sort((a, b) => value(a) - value(b));
  if (nonPower.length) {
    const r = nonPower[0];
    return playAction(p, zone, byRank.get(r));
  }

  // Only powers are legal — use the cheaper 2 before torching with a 10.
  const useRank = byRank.has("2") ? "2" : "10";
  return playAction(p, zone, byRank.get(useRank).slice(0, 1));
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

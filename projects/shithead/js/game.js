// Sh!thead — match state machine.
//
// `applyAction(state, action)` mutates and returns the state; it is the single
// entry point used by the UI (main.js), the CPU (ai.js), and (later) the online
// backend, which deep-clones the canonical state before applying so the engine
// stays the one source of truth for both client and server.
//
// Card sources, in the order a player exhausts them:
//   hand → face-up (only once hand is empty) → face-down (blind, last resort).

import {
  RANKS, SUITS, JOKER, value, defaultOptions, requirement, canPlayRank,
  burnsPile, playableRanks, compareForHand, isJoker, isJokerDefence,
} from "./rules.js";
import { shuffleInPlace } from "./rng.js";

const SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3 };

// Safety net: if this many consecutive turns pass with no burn, finish, or deck
// draw (cards just bouncing back and forth), the pile is force-burned to break
// the deadlock. Set far above anything a real game reaches, so it only ever
// fires on degenerate weak-CPU stalls and never alters a normal match.
const STALL_LIMIT = 120;

function buildDeck(options = {}) {
  const cards = [];
  for (const r of RANKS) for (const s of SUITS) cards.push({ id: `${r}${s}`, rank: r, suit: s });
  if (options.jokers) {
    cards.push({ id: `${JOKER}1`, rank: JOKER, suit: "1" });
    cards.push({ id: `${JOKER}2`, rank: JOKER, suit: "2" });
  }
  return cards;
}

export function clone(state) { return JSON.parse(JSON.stringify(state)); }
export function serialize(state) { return clone(state); }
export function deserialize(obj) { return obj; }

// ---------- Setup ----------

export function createState({ players, options = {}, shuffle } = {}) {
  const opts = { ...defaultOptions(), ...options };
  const deck = buildDeck(opts);
  (shuffle || shuffleInPlace)(deck);

  const ps = players.map((p) => ({
    id: p.id,
    name: p.name,
    isCPU: !!p.isCPU,
    difficulty: p.difficulty || "normal",
    hand: [],
    faceUp: [],
    faceDown: [],
    finished: false,
    place: null,
    ready: false,
  }));

  // Three face-down, three face-up, three to hand — dealt in rounds.
  for (const p of ps) p.faceDown = deck.splice(0, 3);
  for (const p of ps) p.faceUp = deck.splice(0, 3);
  for (const p of ps) p.hand = deck.splice(0, 3);
  for (const p of ps) p.hand.sort(compareForHand);

  const state = {
    version: 1,
    options: opts,
    players: ps,
    deck,
    pile: [],
    burnedCount: 0,
    current: 0,
    direction: 1,            // +1 clockwise, -1 after an odd number of reversing 8s
    jokerAttack: false,      // current player must answer a joker (play a 3 or pick up)
    phase: opts.swapPhase ? "swap" : "play",
    started: false,
    turn: 0,
    stale: 0,
    lastEvent: null,
    shitheadId: null,
    finishOrder: [],
  };

  if (state.phase === "play") beginPlay(state);
  return state;
}

// For starter selection, treat the powers (2, 10, joker) as high so the opener
// is the holder of the lowest "real" climbing card — the rules' "lowest 3".
function starterValue(rank) {
  return (rank === "2" || rank === "10" || rank === JOKER) ? 50 + value(rank) : value(rank);
}

function beginPlay(state) {
  let bestIdx = 0, bestVal = Infinity, bestSuit = 99;
  state.players.forEach((p, i) => {
    for (const c of p.hand) {
      const v = starterValue(c.rank);
      const so = SUIT_ORDER[c.suit];
      if (v < bestVal || (v === bestVal && so < bestSuit)) {
        bestVal = v; bestSuit = so; bestIdx = i;
      }
    }
  });
  state.current = bestIdx;
  state.phase = "play";
  state.started = true;
}

// ---------- Action dispatch ----------

export function applyAction(state, action) {
  switch (action.type) {
    case "swap":   doSwap(state, action); break;
    case "ready":  doReady(state, action); break;
    case "play":   doPlay(state, action); break;
    case "pickup": doPickup(state, action); break;
    default: break;
  }
  tickStale(state);
  return state;
}

function tickStale(state) {
  if (state.phase !== "play") return;
  const e = state.lastEvent;
  if (!e || !(e.type === "play" || e.type === "pickup" || e.type === "blindFail")) return;
  const progressed = e.burned || e.finished || (e.drew && e.drew.length > 0);
  if (progressed) { state.stale = 0; return; }
  state.stale = (state.stale || 0) + 1;
  if (state.stale >= STALL_LIMIT && state.pile.length > 0) {
    state.burnedCount += state.pile.length;
    state.pile = [];
    state.stale = 0;
    state.lastEvent = { ...e, stalemateBurn: true };
  }
}

function playerById(state, id) { return state.players.find((p) => p.id === id); }
function activeCount(state) { return state.players.filter((p) => !p.finished).length; }

function nextActiveIndex(state, from, steps) {
  const n = state.players.length;
  if (activeCount(state) <= 1) return from;
  const dir = state.direction === -1 ? -1 : 1;
  let i = from, moved = 0, guard = 0;
  while (moved < steps && guard < n * (steps + 1) + 2) {
    i = (i + dir + n) % n;
    if (!state.players[i].finished) moved++;
    guard++;
  }
  return i;
}

// ---------- Swap phase ----------

function doSwap(state, { playerId, handId, faceUpId }) {
  if (state.phase !== "swap") return;
  const p = playerById(state, playerId);
  if (!p) return;
  const hi = p.hand.findIndex((c) => c.id === handId);
  const fi = p.faceUp.findIndex((c) => c.id === faceUpId);
  if (hi < 0 || fi < 0) return;
  const tmp = p.hand[hi];
  p.hand[hi] = p.faceUp[fi];
  p.faceUp[fi] = tmp;
  p.hand.sort(compareForHand);
}

function doReady(state, { playerId }) {
  if (state.phase !== "swap") return;
  const p = playerById(state, playerId);
  if (p) p.ready = true;
  if (state.players.every((pl) => pl.ready)) beginPlay(state);
}

// ---------- The active zone a player must play from ----------

export function currentZone(player) {
  if (player.hand.length > 0) return "hand";
  if (player.faceUp.length > 0) return "faceUp";
  if (player.faceDown.length > 0) return "faceDown";
  return null;
}

// What the current player can do this turn. Used by the UI and the CPU.
export function legalSummary(state) {
  const p = state.players[state.current];
  const zone = currentZone(p);
  if (!zone) return { zone: null, ranks: [], mustPickup: false, blind: false, underAttack: false };

  // Under a joker attack the only escape is to play a 3 from a visible zone;
  // otherwise (no 3, or down to blind face-down cards) the pile must be taken.
  if (state.jokerAttack) {
    if (zone === "faceDown") {
      return { zone, ranks: [], mustPickup: true, blind: false, underAttack: true };
    }
    const has3 = p[zone].some((c) => isJokerDefence(c.rank));
    return { zone, ranks: has3 ? ["3"] : [], mustPickup: !has3, blind: false, underAttack: true };
  }

  if (zone === "faceDown") {
    return { zone, ranks: [], mustPickup: false, blind: true, underAttack: false };
  }
  const ranks = playableRanks(p[zone], state.pile, state.options);
  return { zone, ranks, mustPickup: ranks.length === 0, blind: false, underAttack: false };
}

function refillHand(state, p) {
  const drew = [];
  // Top the hand back up to 3 from the deck. The freshly drawn cards live in
  // `drew` until the loop ends, so the guard must count them too — otherwise
  // p.hand.length never moves and the whole deck gets drawn in one go.
  while (p.hand.length + drew.length < 3 && state.deck.length > 0) {
    drew.push(state.deck.shift());
  }
  if (drew.length) {
    p.hand.push(...drew);
    p.hand.sort(compareForHand);
  }
  return drew;
}

function maybeFinish(state, p) {
  if (p.hand.length === 0 && p.faceUp.length === 0 && p.faceDown.length === 0 && !p.finished) {
    p.finished = true;
    state.finishOrder.push(p.id);
    p.place = state.finishOrder.length;
    return true;
  }
  return false;
}

function checkGameOver(state) {
  const active = state.players.filter((pl) => !pl.finished);
  if (active.length <= 1) {
    state.phase = "over";
    if (active.length === 1) {
      const loser = active[0];
      state.shitheadId = loser.id;
      loser.place = state.players.length;
    }
    return true;
  }
  return false;
}

// ---------- Play / pickup ----------

function doPlay(state, { playerId, source, cardIds }) {
  if (state.phase !== "play") return;
  const p = state.players[state.current];
  if (!p || p.id !== playerId || p.finished) return;

  const zone = currentZone(p);
  if (!zone || (source && source !== zone)) return;

  // While under a joker attack the only legal play is a 3 from a visible zone.
  if (state.jokerAttack) {
    if (zone === "faceDown") return;                       // must pick up instead
    const cards = p[zone].filter((c) => cardIds.includes(c.id));
    if (cards.length === 0 || cards.length !== cardIds.length) return;
    if (!cards.every((c) => isJokerDefence(c.rank))) return;
    return deflectJoker(state, p, zone, cards);
  }

  if (zone === "faceDown") return doFaceDown(state, p, cardIds && cardIds[0]);

  const cards = p[zone].filter((c) => cardIds.includes(c.id));
  if (cards.length === 0 || cards.length !== cardIds.length) return;
  const rank = cards[0].rank;
  if (!cards.every((c) => c.rank === rank)) return;

  const req = requirement(state.pile, state.options);
  if (!canPlayRank(rank, req, state.options)) return; // illegal — caller pre-checks

  commitPlay(state, p, zone, cards);
}

// Answer a joker with one or more 3s: they land on the pile and the obligation
// to take it passes, unchanged, to the next player. No burns resolve mid-chain.
function deflectJoker(state, p, zone, cards) {
  const ids = new Set(cards.map((c) => c.id));
  p[zone] = p[zone].filter((c) => !ids.has(c.id));
  state.pile.push(...cards);

  const drew = zone === "hand" ? refillHand(state, p) : [];
  const finished = maybeFinish(state, p);

  state.lastEvent = {
    type: "play", playerId: p.id, zone, cards, burned: false, skip: 0,
    drew, finished, wasBlind: false, rank: "3", deflect: true,
  };

  if (checkGameOver(state)) return;
  // jokerAttack stays true — the next player now faces the same pile.
  state.current = nextActiveIndex(state, state.current, 1);
  state.turn++;
}

// Blind face-down flip: reveal one card; it stays if legal, otherwise the player
// scoops the pile plus the flipped card.
function doFaceDown(state, p, cardId) {
  let card, idx;
  if (cardId) {
    idx = p.faceDown.findIndex((c) => c.id === cardId);
  } else {
    idx = 0;
  }
  if (idx < 0) idx = 0;
  card = p.faceDown[idx];
  if (!card) return;

  const req = requirement(state.pile, state.options);
  const legal = canPlayRank(card.rank, req, state.options);
  p.faceDown.splice(idx, 1);

  if (legal) {
    // Re-insert so commitPlay can pull it from the zone uniformly.
    p.faceDown.splice(idx, 0, card);
    commitPlay(state, p, "faceDown", [card], /*wasBlind*/ true);
    return;
  }

  // Failed flip: take the pile plus this card.
  const taken = state.pile.concat([card]);
  state.pile = [];
  p.hand.push(...taken);
  p.hand.sort(compareForHand);
  state.lastEvent = { type: "blindFail", playerId: p.id, card, count: taken.length };
  state.current = nextActiveIndex(state, state.current, 1);
  state.turn++;
  checkGameOver(state);
}

function commitPlay(state, p, zone, cards, wasBlind = false) {
  // Remove from the zone.
  const ids = new Set(cards.map((c) => c.id));
  p[zone] = p[zone].filter((c) => !ids.has(c.id));
  // Lay on the pile.
  state.pile.push(...cards);

  // A joker never burns — it puts the next player under attack instead.
  const playedJoker = isJoker(cards[0].rank);
  const burned = !playedJoker && burnsPile(cards, state.pile, state.options);

  if (burned) {
    state.burnedCount += state.pile.length;
    state.pile = [];
  }
  if (playedJoker) state.jokerAttack = true;

  const drew = zone === "hand" ? refillHand(state, p) : [];
  const finished = maybeFinish(state, p);

  state.lastEvent = {
    type: "play",
    playerId: p.id,
    zone,
    cards,
    burned,
    skip: 0,
    drew,
    finished,
    wasBlind,
    rank: cards[0].rank,
    joker: playedJoker,
  };

  if (checkGameOver(state)) return;

  // Burning grants another go on the now-empty pile (jokers never burn).
  if (burned && state.options.replayOnBurn && !finished) {
    state.turn++;
    return;
  }

  const steps = advanceSteps(state, cards, burned);
  state.lastEvent.skip = Math.max(0, steps - 1);
  state.current = nextActiveIndex(state, state.current, steps);
  state.turn++;
}

// Active seats to advance after a normal (non-burn) play. An 8 either skips the
// next player (skip mode) or flips the table direction (reverse mode); with only
// two players left a reversing 8 simply bounces back, so it acts like a skip.
function advanceSteps(state, cards, burned) {
  if (burned) return 1;
  const eights = cards.filter((c) => c.rank === "8").length;
  if (eights === 0) return 1;
  const mode = state.options.eightMode;
  if (mode === "skip") return 1 + eights;
  if (mode === "reverse") {
    if (activeCount(state) <= 2) return 1 + eights;   // bounces straight back
    if (eights % 2 === 1) state.direction *= -1;       // an odd run flips the table
    return 1;
  }
  return 1; // invisible — no positional effect
}

function doPickup(state, { playerId }) {
  if (state.phase !== "play") return;
  const p = state.players[state.current];
  if (!p || p.id !== playerId || p.finished) return;
  if (state.pile.length === 0) return;

  const count = state.pile.length;
  const fromJoker = state.jokerAttack;
  p.hand.push(...state.pile);
  p.hand.sort(compareForHand);
  state.pile = [];
  state.jokerAttack = false;               // the attack ends when the pile is taken
  state.lastEvent = { type: "pickup", playerId: p.id, count, fromJoker };
  state.current = nextActiveIndex(state, state.current, 1);
  state.turn++;
  checkGameOver(state);
}

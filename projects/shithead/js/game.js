// Sh!thead — match state machine.
//
// `applyAction(state, action)` mutates and returns the state; it is the single
// entry point used by the UI (main.js) and the CPU (ai.js), keeping the engine
// the one source of truth for game logic.
//
// Card sources, in the order a player exhausts them:
//   hand → face-up (only once hand is empty) → face-down (blind, last resort).

import {
  RANKS, SUITS, JOKER, value, defaultOptions, requirement, canPlayRank,
  burnsPile, playableRanks, compareForHand, isJoker, isJokerAnswer,
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

export function createState({ players, options = {}, shuffle, forcedStarter = null } = {}) {
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
    // Per-player card-counting memory the CPU uses: ranks each player is known
    // to hold because they picked up a (publicly visible) pile. Pruned as they
    // shed those cards. Public information — fair game for a card-counter.
    memory: {},
    // When set (a player id, e.g. from the dealer spinner) this player opens the
    // round; otherwise the rules' lowest-card holder does.
    forcedStarter: forcedStarter || null,
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
  const forced = state.forcedStarter != null
    ? state.players.findIndex((p) => p.id === state.forcedStarter) : -1;
  if (forced >= 0) {
    state.current = forced;
  } else {
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
  }
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
    case "takeFaceUp": doTakeFaceUp(state, action); break;
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
    state.jokerAttack = false;   // the attacked pile is gone — clear the obligation
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
  // Once the deck is spent, face-up cards top the hand back up to 3 (the player
  // taps them in, then plays from hand). Available whenever there's room.
  const canTakeFaceUp = canTakeFaceUpNow(state, p);
  const base = { zone, ranks: [], mustPickup: false, blind: false, underAttack: false, canTakeFaceUp: false };
  if (!zone) return { ...base, zone: null };

  // Under a joker attack the escape is to answer with a 3 (or another joker) from
  // a visible zone; otherwise the pile must be taken. Down to blind face-down
  // cards, the card is still flipped in full view — it deflects if it happens to
  // be a 3/joker, and is scooped up with the pile otherwise (see doFaceDown…).
  if (state.jokerAttack) {
    if (zone === "faceDown") {
      return { ...base, blind: true, underAttack: true };
    }
    const answers = [...new Set(p[zone].filter((c) => isJokerAnswer(c.rank, state.options)).map((c) => c.rank))];
    return { ...base, ranks: answers, mustPickup: answers.length === 0, underAttack: true };
  }

  if (zone === "faceDown") {
    return { ...base, blind: true };
  }
  // Face-up cards (empty hand) — must be taken into hand before any play.
  if (zone === "faceUp") {
    return { ...base, canTakeFaceUp: true };
  }
  // Normal hand turn — but you may also top up from face-up if the deck's gone.
  const ranks = playableRanks(p[zone], state.pile, state.options);
  return { ...base, ranks, mustPickup: ranks.length === 0, canTakeFaceUp };
}

// May the current player pull face-up cards into hand right now? Only once the
// deck is gone, there are face-up cards left, the hand has room (< 3), and
// they're not pinned by a joker attack.
function canTakeFaceUpNow(state, p) {
  return !state.jokerAttack && state.deck.length === 0 && p.faceUp.length > 0 && p.hand.length < 3;
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

  // While under a joker attack the only legal play is a 3 (or another joker) from
  // a visible zone — or a blind flip of a face-down card, which is turned over in
  // full view and either deflects (a 3/joker) or is scooped up with the pile.
  if (state.jokerAttack) {
    if (zone === "faceDown") return doFaceDownUnderAttack(state, p, cardIds && cardIds[0]);
    const cards = p[zone].filter((c) => cardIds.includes(c.id));
    if (cards.length === 0 || cards.length !== cardIds.length) return;
    if (!cards.every((c) => isJokerAnswer(c.rank, state.options))) return;
    return deflectJoker(state, p, zone, cards);
  }

  if (zone === "faceDown") return doFaceDown(state, p, cardIds && cardIds[0]);
  // Face-up cards can't be played straight to the pile — they must be taken
  // into hand first (see doTakeFaceUp). The joker-defence case above is the
  // only time a card leaves the face-up row directly.
  if (zone === "faceUp") return;

  const cards = p[zone].filter((c) => cardIds.includes(c.id));
  if (cards.length === 0 || cards.length !== cardIds.length) return;
  const rank = cards[0].rank;
  if (!cards.every((c) => c.rank === rank)) return;

  const req = requirement(state.pile, state.options);
  if (!canPlayRank(rank, req, state.options)) return; // illegal — caller pre-checks

  commitPlay(state, p, zone, cards);
}

// Take face-up table cards into the hand (up to 3) once the hand is empty and
// the deck is spent. Does NOT end the turn — the player then plays from hand as
// usual. Blind face-down cards are untouched (those stay a one-per-turn gamble).
function doTakeFaceUp(state, { playerId, cardIds }) {
  if (state.phase !== "play") return;
  const p = state.players[state.current];
  if (!p || p.id !== playerId || p.finished) return;
  if (!canTakeFaceUpNow(state, p)) return;       // deck gone, face-up left, hand has room
  const want = new Set(cardIds || []);
  const take = p.faceUp.filter((c) => want.has(c.id)).slice(0, 3 - p.hand.length);
  if (take.length === 0) return;
  const taken = new Set(take.map((c) => c.id));
  p.faceUp = p.faceUp.filter((c) => !taken.has(c.id));
  p.hand.push(...take);
  p.hand.sort(compareForHand);
  state.lastEvent = { type: "takeFaceUp", playerId: p.id, cards: take };
}

// Answer a joker with one or more 3s (or another joker): they land on the pile
// and the obligation to take it passes, unchanged, to the next player. No burns
// resolve mid-chain.
function deflectJoker(state, p, zone, cards, wasBlind = false) {
  const ids = new Set(cards.map((c) => c.id));
  p[zone] = p[zone].filter((c) => !ids.has(c.id));
  forgetPlayed(state, p.id, cards);
  state.pile.push(...cards);

  const drew = zone === "hand" ? refillHand(state, p) : [];
  const finished = maybeFinish(state, p);

  state.lastEvent = {
    type: "play", playerId: p.id, zone, cards, burned: false, skip: 0,
    drew, finished, wasBlind, rank: cards[0].rank, deflect: true,
  };

  if (checkGameOver(state)) return;
  // jokerAttack stays true — the next player now faces the same pile.
  state.current = nextActiveIndex(state, state.current, 1);
  state.turn++;
}

// Under a joker attack with only blind face-down cards left: flip one in full
// view on top of the joker pile. A 3 (or another joker) deflects the attack to
// the next player; anything else means the whole pile — flipped card included —
// is scooped up immediately, ending the attack.
function doFaceDownUnderAttack(state, p, cardId) {
  let idx = cardId ? p.faceDown.findIndex((c) => c.id === cardId) : 0;
  if (idx < 0) idx = 0;
  const card = p.faceDown[idx];
  if (!card) return;
  p.faceDown.splice(idx, 1);

  if (isJokerAnswer(card.rank, state.options)) {
    // The flip happens to answer the joker — re-insert so deflectJoker can pull
    // it from the zone uniformly, then pass the attack on (flagged as blind).
    p.faceDown.splice(idx, 0, card);
    return deflectJoker(state, p, "faceDown", [card], /*wasBlind*/ true);
  }

  // No defence — the flipped card joins the pile and the player scoops it all.
  const taken = state.pile.concat([card]);
  state.pile = [];
  state.jokerAttack = false;
  p.hand.push(...taken);
  p.hand.sort(compareForHand);
  state.lastEvent = { type: "blindFail", playerId: p.id, card, count: taken.length, fromJoker: true };
  state.current = nextActiveIndex(state, state.current, 1);
  state.turn++;
  checkGameOver(state);
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

// ---------- CPU pickup memory (public information) ----------
// Track the ranks a player is known to hold after taking a pile, and forget
// them as the player plays matching cards. Capped so it can't grow unbounded.
const MEMORY_CAP = 18;
function rememberPickup(state, id, pile) {
  if (!state.memory) state.memory = {};
  const known = (state.memory[id] || []).concat(pile.map((c) => c.rank));
  state.memory[id] = known.slice(-MEMORY_CAP);
}
function forgetPlayed(state, id, cards) {
  const known = state.memory && state.memory[id];
  if (!known || !known.length) return;
  for (const c of cards) {
    const i = known.indexOf(c.rank);
    if (i >= 0) known.splice(i, 1);
  }
}

function commitPlay(state, p, zone, cards, wasBlind = false) {
  // Remove from the zone.
  const ids = new Set(cards.map((c) => c.id));
  p[zone] = p[zone].filter((c) => !ids.has(c.id));
  forgetPlayed(state, p.id, cards);
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
  if (state.pile.length === 0) { state.jokerAttack = false; return; } // nothing to take; drop any stale attack

  const count = state.pile.length;
  const fromJoker = state.jokerAttack;
  // Remember the (public) ranks this player just scooped into hand.
  rememberPickup(state, p.id, state.pile);
  p.hand.push(...state.pile);
  p.hand.sort(compareForHand);
  state.pile = [];
  state.jokerAttack = false;               // the attack ends when the pile is taken
  state.lastEvent = { type: "pickup", playerId: p.id, count, fromJoker };
  state.current = nextActiveIndex(state, state.current, 1);
  state.turn++;
  checkGameOver(state);
}

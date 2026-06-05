import { describe, it, expect } from "vitest";
import {
  createState, applyAction, currentZone, legalSummary, clone,
} from "../../projects/shithead/js/game.js";
import * as R from "../../projects/shithead/js/rules.js";

const C = (id) => ({ id, rank: id.slice(0, -1), suit: id.slice(-1) });
const cs = (...ids) => ids.map(C);

function baseState(over = {}) {
  const mk = (id, isCPU) => ({
    id, name: id.toUpperCase(), isCPU, difficulty: "normal",
    hand: [], faceUp: [], faceDown: [], finished: false, place: null, ready: true,
  });
  return {
    version: 1,
    options: R.defaultOptions(),
    players: [mk("a", false), mk("b", true)],
    deck: [], pile: [], burnedCount: 0, current: 0,
    direction: 1, jokerAttack: false,
    phase: "play", started: true, turn: 0, lastEvent: null,
    shitheadId: null, finishOrder: [],
    ...over,
  };
}

describe("createState dealing", () => {
  it("deals 3/3/3 and leaves the rest in the deck", () => {
    const s = createState({
      players: [{ id: "a", name: "A" }, { id: "b", name: "B", isCPU: true }],
      shuffle: (a) => a, // deterministic: no shuffle
    });
    for (const p of s.players) {
      expect(p.hand.length).toBe(3);
      expect(p.faceUp.length).toBe(3);
      expect(p.faceDown.length).toBe(3);
    }
    expect(s.deck.length).toBe(52 - 18);
    expect(s.phase).toBe("swap"); // swapPhase default on
  });

  it("skips the swap phase and picks an opener when swapPhase is off", () => {
    const s = createState({
      players: [{ id: "a", name: "A" }, { id: "b", name: "B", isCPU: true }],
      options: { swapPhase: false },
      shuffle: (a) => a,
    });
    expect(s.phase).toBe("play");
    expect(s.started).toBe(true);
  });
});

describe("swap phase", () => {
  it("swaps a hand card with a face-up card and readies into play", () => {
    const s = createState({
      players: [{ id: "a", name: "A" }, { id: "b", name: "B", isCPU: true }],
      shuffle: (a) => a,
    });
    const hId = s.players[0].hand[0].id;
    const fId = s.players[0].faceUp[0].id;
    applyAction(s, { type: "swap", playerId: "a", handId: hId, faceUpId: fId });
    expect(s.players[0].faceUp.some((c) => c.id === hId)).toBe(true);
    expect(s.players[0].hand.some((c) => c.id === fId)).toBe(true);

    applyAction(s, { type: "ready", playerId: "a" });
    applyAction(s, { type: "ready", playerId: "b" });
    expect(s.phase).toBe("play");
  });
});

describe("playing", () => {
  it("plays a card, refills the hand to three, and passes the turn", () => {
    const s = baseState();
    s.players[0].hand = cs("5S");
    s.deck = cs("KD", "QD", "JD");
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["5S"] });
    expect(s.pile.map((c) => c.id)).toEqual(["5S"]);
    expect(s.players[0].hand.length).toBe(3); // refilled
    expect(s.current).toBe(1);
  });

  it("refills to exactly three from a larger deck — never drains the deck", () => {
    const s = baseState();
    s.players[0].hand = cs("5S", "6H", "7D");          // a full 3-card hand
    s.deck = cs("KD", "QD", "JD", "TS", "9C", "8H");   // plenty left in the deck
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["5S"] });
    expect(s.players[0].hand.length).toBe(3);          // drew exactly 1, not the lot
    expect(s.deck.length).toBe(5);                     // only one card left the deck
  });

  it("rejects an illegal play (no-op)", () => {
    const s = baseState();
    s.players[0].hand = cs("4S", "9H");
    s.pile = cs("KS");
    const before = clone(s);
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["4S"] });
    expect(s.pile).toEqual(before.pile);
    expect(s.current).toBe(0);
  });

  it("a 10 burns the pile and the player replays", () => {
    const s = baseState();
    s.players[0].hand = cs("10S", "4H");
    s.pile = cs("KS", "QH");
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["10S"] });
    expect(s.pile.length).toBe(0);
    expect(s.burnedCount).toBe(3); // KS, QH, 10S
    expect(s.current).toBe(0); // replay
    expect(s.lastEvent.burned).toBe(true);
  });

  it("completing a four-of-a-kind across turns burns", () => {
    const s = baseState();
    s.players[0].hand = cs("9C");
    s.pile = cs("9S", "9H", "9D");
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["9C"] });
    expect(s.pile.length).toBe(0);
    expect(s.current).toBe(0); // replay on burn
  });

  it("plays multiple of the same rank at once", () => {
    const s = baseState();
    s.players[0].hand = cs("6S", "6H", "6D");
    s.pile = cs("4S");
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["6S", "6H"] });
    expect(s.pile.map((c) => c.id).sort()).toEqual(["4S", "6H", "6S"].sort());
    expect(s.current).toBe(1);
  });
});

describe("skip-mode 8", () => {
  it("an 8 skips the next player", () => {
    const mk = (id) => ({ id, name: id, isCPU: true, difficulty: "normal", hand: [], faceUp: [], faceDown: [], finished: false, place: null, ready: true });
    const s = baseState({ players: [mk("a"), mk("b"), mk("c")], options: { ...R.defaultOptions(), eightMode: "skip" } });
    s.players[0].hand = cs("8S");
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["8S"] });
    expect(s.current).toBe(2); // b skipped
  });
});

describe("jokers", () => {
  const mk3 = () => {
    const mk = (id) => ({ id, name: id, isCPU: true, difficulty: "normal", hand: [], faceUp: [], faceDown: [], finished: false, place: null, ready: true });
    return baseState({ players: [mk("a"), mk("b"), mk("c")], options: { ...R.defaultOptions(), jokers: true } });
  };

  it("deals two jokers into the deck when enabled", () => {
    const s = createState({
      players: [{ id: "a", name: "A" }, { id: "b", name: "B", isCPU: true }],
      options: { jokers: true },
      shuffle: (a) => a,
    });
    expect(s.deck.length).toBe(54 - 18);
  });

  it("a joker forces the next player (with no 3) to take the whole pile", () => {
    const s = baseState({ options: { ...R.defaultOptions(), jokers: true } });
    s.players[0].hand = cs("JK1", "5C");   // keep a card so 'a' doesn't finish
    s.players[1].hand = cs("9H");          // 'b' has no 3 to deflect
    s.pile = cs("KS", "QH");
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["JK1"] });
    expect(s.jokerAttack).toBe(true);
    expect(s.current).toBe(1);
    const summ = legalSummary(s);
    expect(summ.underAttack).toBe(true);
    expect(summ.mustPickup).toBe(true);

    applyAction(s, { type: "pickup", playerId: "b" });
    expect(s.jokerAttack).toBe(false);
    expect(s.pile.length).toBe(0);
    expect(s.players[1].hand.map((c) => c.id).sort()).toEqual(["9H", "JK1", "KS", "QH"].sort());
  });

  it("a 3 deflects the joker to the following player", () => {
    const s = mk3();
    s.players[0].hand = cs("JK1", "5C");
    s.players[1].hand = cs("3H", "9C");    // 'b' can deflect
    s.players[2].hand = cs("8C");          // 'c' cannot
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["JK1"] });
    expect(s.current).toBe(1);
    expect(legalSummary(s).ranks).toEqual(["3"]);

    applyAction(s, { type: "play", playerId: "b", source: "hand", cardIds: ["3H"] });
    expect(s.jokerAttack).toBe(true);      // attack passes on, unresolved
    expect(s.current).toBe(2);
    expect(legalSummary(s).mustPickup).toBe(true);

    applyAction(s, { type: "pickup", playerId: "c" });
    expect(s.jokerAttack).toBe(false);
    expect(s.players[2].hand.map((c) => c.id).sort()).toEqual(["3H", "8C", "JK1"].sort());
  });

  it("rejects a non-3 played while under attack", () => {
    const s = mk3();
    s.players[0].hand = cs("JK1", "5C");
    s.players[1].hand = cs("9C", "3H");
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["JK1"] });
    const before = clone(s);
    applyAction(s, { type: "play", playerId: "b", source: "hand", cardIds: ["9C"] });
    expect(s.current).toBe(before.current);
    expect(s.jokerAttack).toBe(true);
  });
});

describe("reverse-mode 8", () => {
  const mk = (id) => ({ id, name: id, isCPU: true, difficulty: "normal", hand: [], faceUp: [], faceDown: [], finished: false, place: null, ready: true });

  it("flips the table direction with 3+ players", () => {
    const s = baseState({ players: [mk("a"), mk("b"), mk("c")], options: { ...R.defaultOptions(), eightMode: "reverse" } });
    s.players[0].hand = cs("8S", "4C");
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["8S"] });
    expect(s.direction).toBe(-1);
    expect(s.current).toBe(2); // a → c (anticlockwise)
  });

  it("bounces straight back to you with two players", () => {
    const s = baseState({ players: [mk("a"), mk("b")], options: { ...R.defaultOptions(), eightMode: "reverse" } });
    s.players[0].hand = cs("8S", "4C");
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["8S"] });
    expect(s.current).toBe(0); // a plays again
  });
});

describe("pickup", () => {
  it("scoops the pile and passes the turn", () => {
    const s = baseState();
    s.players[0].hand = cs("4S");
    s.pile = cs("KS", "QH");
    expect(legalSummary(s).mustPickup).toBe(true);
    applyAction(s, { type: "pickup", playerId: "a" });
    expect(s.pile.length).toBe(0);
    expect(s.players[0].hand.map((c) => c.id).sort()).toEqual(["4S", "KS", "QH"].sort());
    expect(s.current).toBe(1);
  });
});

describe("face-down blind flips", () => {
  it("a legal flip plays the card", () => {
    const s = baseState();
    s.players[0].faceDown = cs("KS");
    s.pile = cs("4H");
    expect(currentZone(s.players[0])).toBe("faceDown");
    applyAction(s, { type: "play", playerId: "a", source: "faceDown", cardIds: ["KS"] });
    expect(s.pile.map((c) => c.id)).toEqual(["4H", "KS"]);
    expect(s.players[0].faceDown.length).toBe(0);
  });

  it("an illegal flip scoops the pile plus the flipped card", () => {
    const s = baseState();
    s.players[0].faceDown = cs("4S", "5D");
    s.pile = cs("KS", "QH");
    applyAction(s, { type: "play", playerId: "a", source: "faceDown", cardIds: ["4S"] });
    expect(s.pile.length).toBe(0);
    expect(s.players[0].hand.map((c) => c.id).sort()).toEqual(["4S", "KS", "QH"].sort());
    expect(s.players[0].faceDown.map((c) => c.id)).toEqual(["5D"]);
    expect(s.current).toBe(1);
    expect(s.lastEvent.type).toBe("blindFail");
  });
});

describe("finishing and the shithead", () => {
  it("emptying every zone finishes a player; the last with cards loses", () => {
    const s = baseState();
    s.players[0].hand = cs("KS");
    s.players[0].faceUp = [];
    s.players[0].faceDown = [];
    s.players[1].hand = cs("4H");
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["KS"] });
    expect(s.players[0].finished).toBe(true);
    expect(s.players[0].place).toBe(1);
    expect(s.phase).toBe("over");
    expect(s.shitheadId).toBe("b");
    expect(s.players[1].place).toBe(2);
  });
});

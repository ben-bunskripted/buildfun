import { describe, it, expect } from "vitest";
import { createState, applyAction } from "../../projects/shithead/js/game.js";
import { planTurn } from "../../projects/shithead/js/ai.js";

// A fresh 2-player game already in the play phase (no swap), with both zones
// under our control for crafting precise scenarios.
function playGame(opts = {}) {
  const s = createState({
    players: [
      { id: "a", name: "A", isCPU: true, difficulty: "hard" },
      { id: "b", name: "B", isCPU: true, difficulty: "hard" },
    ],
    options: { swapPhase: false, ...opts },
  });
  s.current = 0;            // it's A's move
  s.direction = 1;
  return s;
}
const card = (rank, suit) => ({ rank, suit, id: rank + suit });

describe("four-of-a-kind burns across turns", () => {
  it("completing the fourth same-rank card on the pile burns it", () => {
    const s = playGame({ tenPower: true, fourKindAcrossTurns: true });
    const a = s.players[0];
    s.pile = [card("4", "S"), card("4", "H"), card("4", "D")];   // three 4s already down
    a.hand = [card("4", "C"), card("K", "S")];
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["4C"] });
    expect(s.lastEvent.burned).toBe(true);
    expect(s.pile.length).toBe(0);
  });

  it("does not burn at only three of a rank", () => {
    const s = playGame({ fourKindAcrossTurns: true });
    const a = s.players[0];
    s.pile = [card("4", "S"), card("4", "H")];
    a.hand = [card("4", "C"), card("K", "S")];
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["4C"] });
    expect(s.lastEvent.burned).toBe(false);
  });
});

describe("CPU pickup memory + endgame pressure", () => {
  it("remembers the ranks a player scoops, and forgets them as they're played", () => {
    const s = playGame();
    const a = s.players[0];
    s.pile = [card("9", "S"), card("5", "H")];
    applyAction(s, { type: "pickup", playerId: "a" });
    expect(s.memory.a).toEqual(expect.arrayContaining(["9", "5"]));
    // A now plays the 9 back out on its next turn → memory drops it.
    s.current = 0;
    s.pile = [];
    applyAction(s, { type: "play", playerId: "a", source: "hand", cardIds: ["9S"] });
    expect(s.memory.a).not.toContain("9");
    expect(s.memory.a).toContain("5");
  });

  it("plays a high card to pressure an opponent who is about to go out", () => {
    const s = playGame();
    const a = s.players[0], b = s.players[1];
    s.pile = [];
    a.hand = [card("4", "S"), card("K", "H")];
    b.hand = [card("5", "C")]; b.faceUp = []; b.faceDown = [];   // one card from winning
    const act = planTurn(s);
    expect(act.cardIds).toContain("KH");                          // slam high, not the 4
  });

  it("plays the cheapest card above an opponent's known holdings to force a pickup", () => {
    const s = playGame();
    const a = s.players[0], b = s.players[1];
    s.pile = [];
    a.hand = [card("4", "S"), card("7", "S"), card("K", "H")];
    b.hand = [card("x1"), card("x2"), card("x3"), card("x4"), card("x5")];
    b.faceUp = [card("y1"), card("y2"), card("y3")];             // not close
    s.memory = { b: ["6", "5", "2"] };                            // known max held = 6
    const act = planTurn(s);
    expect(act.cardIds).toContain("7S");                          // cheapest card above a 6
  });
});

describe("engine robustness", () => {
  it("a pickup with an empty pile clears any stale joker attack instead of looping", () => {
    const s = playGame({ jokers: true });
    s.jokerAttack = true;
    s.pile = [];
    const before = s.current;
    applyAction(s, { type: "pickup", playerId: s.players[before].id });
    expect(s.jokerAttack).toBe(false);     // no infinite "pick up an empty pile"
  });
});

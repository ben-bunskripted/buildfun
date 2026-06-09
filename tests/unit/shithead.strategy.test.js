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

describe("CPU pickup memory (engine, public info)", () => {
  it("remembers the ranks a player scoops, and forgets them as they're played", () => {
    const s = playGame();
    const a = s.players[0];
    a.hand = [];                                   // clear the dealt hand so injected ids can't collide
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
});

describe("CPU play selection", () => {
  it("completes a four-of-a-kind already on the pile to burn it", () => {
    const s = playGame();
    const a = s.players[0];
    s.pile = [card("5", "S"), card("5", "H"), card("5", "D")];   // three 5s down
    a.hand = [card("5", "C"), card("9", "S")];                   // we hold the fourth
    const act = planTurn(s);
    expect(act.cardIds).toContain("5C");                          // complete the four, not the 9
    applyAction(s, act);
    expect(s.lastEvent.burned).toBe(true);
    expect(s.pile.length).toBe(0);
  });

  it("lays a held four-of-a-kind to burn rather than shedding a single low card", () => {
    const s = playGame();
    const a = s.players[0];
    s.pile = [];                                                  // free pile
    a.hand = [card("3", "S"), card("8", "S"), card("8", "H"), card("8", "D"), card("8", "C")];
    const act = planTurn(s);
    expect(act.cardIds.slice().sort()).toEqual(["8C", "8D", "8H", "8S"]);
    applyAction(s, act);
    expect(s.lastEvent.burned).toBe(true);
    expect(s.pile.length).toBe(0);
  });

  it("resets a high pile with a cheap 2 rather than spending a high card", () => {
    const s = playGame();
    const a = s.players[0];
    s.pile = [card("K", "S")];                                    // a king is showing
    a.hand = [card("2", "C"), card("A", "H")];                    // could climb with the ace, or reset
    const act = planTurn(s);
    expect(act.cardIds).toEqual(["2C"]);                          // keep the ace, dump the disposable 2
  });

  it("does not waste a 2 on a low pile — climbs cheaply and hoards the 2", () => {
    const s = playGame();
    const a = s.players[0];
    s.pile = [card("4", "S")];                                    // a low card is showing
    a.hand = [card("2", "C"), card("6", "H"), card("9", "D")];
    const act = planTurn(s);
    expect(act.cardIds).toEqual(["6H"]);                          // cheapest plain climb, 2 stays in reserve
  });

  it("in the endgame plays Aces one at a time, keeping one as a universal escape", () => {
    const s = playGame();
    const a = s.players[0];
    s.deck = [];                                                  // deck spent → endgame
    s.pile = [];
    a.hand = [card("A", "S"), card("A", "H")];                    // a pair of aces, nothing else
    const act = planTurn(s);
    expect(act.cardIds).toEqual(["AS"]);                          // one ace, keep the other in reserve
  });

  it("still dumps a pair of Aces together while the deck still has cards", () => {
    const s = playGame();
    const a = s.players[0];
    expect(s.deck.length).toBeGreaterThan(0);                     // mid-game: hand refills, no reserve needed
    s.pile = [];
    a.hand = [card("A", "S"), card("A", "H")];
    const act = planTurn(s);
    expect(act.cardIds.slice().sort()).toEqual(["AH", "AS"]);     // both go
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

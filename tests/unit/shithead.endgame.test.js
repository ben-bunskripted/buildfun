import { describe, it, expect } from "vitest";
import { createState, applyAction, currentZone, legalSummary } from "../../projects/shithead/js/game.js";
import { planTurn } from "../../projects/shithead/js/ai.js";

function playGame(opts = {}) {
  const s = createState({
    players: [
      { id: "a", name: "A", isCPU: true, difficulty: "hard" },
      { id: "b", name: "B", isCPU: true, difficulty: "hard" },
    ],
    options: { swapPhase: false, ...opts },
  });
  s.current = 0;
  return s;
}
const card = (rank, suit) => ({ rank, suit, id: rank + suit });

// Put player A into the endgame: empty hand, no deck, three face-up cards left.
function faceUpEndgame(s, faceUp) {
  const a = s.players[0];
  s.deck = [];
  a.hand = [];
  a.faceUp = faceUp;
  return a;
}

describe("face-up cards are taken into hand, then played", () => {
  it("an empty hand with face-up cards left offers a take, not a direct play", () => {
    const s = playGame();
    const a = faceUpEndgame(s, [card("K", "S"), card("5", "H"), card("9", "D")]);
    expect(currentZone(a)).toBe("faceUp");
    const summ = legalSummary(s);
    expect(summ.canTakeFaceUp).toBe(true);
    expect(summ.blind).toBe(false);
  });

  it("takeFaceUp moves the chosen cards into hand (max 3) without ending the turn", () => {
    const s = playGame();
    const a = faceUpEndgame(s, [card("K", "S"), card("5", "H"), card("9", "D")]);
    const turnBefore = s.turn;
    applyAction(s, { type: "takeFaceUp", playerId: "a", cardIds: ["KS", "5H", "9D"] });
    expect(a.hand.map((c) => c.id).sort()).toEqual(["5H", "9D", "KS"]);
    expect(a.faceUp.length).toBe(0);
    expect(s.turn).toBe(turnBefore);              // pre-play pickup, not a turn
    expect(currentZone(a)).toBe("hand");          // now plays from hand
  });

  it("tops the hand up to 3 from face-up, never beyond", () => {
    const s = playGame();
    const a = faceUpEndgame(s, [card("K", "S"), card("5", "H"), card("9", "D")]);
    a.hand = [card("2", "C")];                      // already holds one
    applyAction(s, { type: "takeFaceUp", playerId: "a", cardIds: ["KS", "5H", "9D"] });
    expect(a.hand.length).toBe(3);                  // 1 + 2 taken
    expect(a.faceUp.length).toBe(1);                // one left for later
  });

  it("won't take face-up cards while the deck still has cards", () => {
    const s = playGame();
    const a = faceUpEndgame(s, [card("K", "S"), card("5", "H"), card("9", "D")]);
    s.deck = [card("3", "C")];                      // deck not empty yet
    a.hand = [];
    applyAction(s, { type: "takeFaceUp", playerId: "a", cardIds: ["KS"] });
    expect(a.faceUp.length).toBe(3);               // unchanged — refill from deck first
  });

  it("rejects a direct play straight off the face-up row", () => {
    const s = playGame();
    const a = faceUpEndgame(s, [card("K", "S"), card("5", "H"), card("9", "D")]);
    s.pile = [];
    applyAction(s, { type: "play", playerId: "a", source: "faceUp", cardIds: ["KS"] });
    expect(a.faceUp.some((c) => c.id === "KS")).toBe(true);   // still on the table
    expect(s.pile.length).toBe(0);
  });

  it("the CPU scoops its face-up cards into hand when its hand is empty", () => {
    const s = playGame();
    faceUpEndgame(s, [card("K", "S"), card("5", "H")]);
    const act = planTurn(s);
    expect(act.type).toBe("takeFaceUp");
    expect(act.cardIds).toEqual(expect.arrayContaining(["KS", "5H"]));
  });
});

describe("face-down cards stay blind and last", () => {
  it("face-down is only reached once hand and face-up are empty, and stays blind", () => {
    const s = playGame();
    const a = s.players[0];
    s.deck = [];
    a.hand = []; a.faceUp = [];
    a.faceDown = [card("7", "S"), card("2", "H"), card("9", "D")];
    expect(currentZone(a)).toBe("faceDown");
    const summ = legalSummary(s);
    expect(summ.blind).toBe(true);
    expect(summ.canTakeFaceUp).toBe(false);
  });
});

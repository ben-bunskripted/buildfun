import { describe, it, expect } from "vitest";
import { createState, applyAction } from "../../projects/shithead/js/game.js";
import { planTurn, planSwaps } from "../../projects/shithead/js/ai.js";

// Drives a whole CPU-vs-CPU match to completion. Catches illegal actions,
// stuck turns, and non-terminating games.
function autoSwapAndStart(s) {
  for (const p of s.players) {
    for (const sw of planSwaps(p)) {
      applyAction(s, { type: "swap", playerId: p.id, handId: sw.handId, faceUpId: sw.faceUpId });
    }
  }
  for (const p of s.players) applyAction(s, { type: "ready", playerId: p.id });
}

function playOut(s, maxTurns = 6000) {
  let i = 0;
  while (s.phase === "play" && i < maxTurns) {
    const action = planTurn(s);
    applyAction(s, action);
    i++;
  }
  return i;
}

describe("CPU self-play", () => {
  const tiers = ["easy", "normal", "hard"];
  for (const diff of tiers) {
    for (let n = 2; n <= 4; n++) {
      it(`${n}-player ${diff} game terminates with exactly one shithead`, () => {
        for (let game = 0; game < 6; game++) {
          const players = Array.from({ length: n }, (_, k) => ({
            id: `p${k}`, name: `P${k}`, isCPU: true, difficulty: diff,
          }));
          const s = createState({ players, options: { eightMode: game % 2 ? "skip" : "invisible" } });
          autoSwapAndStart(s);
          const turns = playOut(s);
          expect(s.phase).toBe("over");
          expect(turns).toBeLessThan(6000);
          // Exactly one player still holds cards, and they are the shithead.
          const withCards = s.players.filter(
            (p) => p.hand.length || p.faceUp.length || p.faceDown.length,
          );
          expect(withCards.length).toBe(1);
          expect(s.shitheadId).toBe(withCards[0].id);
          // Everyone else finished and has a place.
          const finished = s.players.filter((p) => p.finished);
          expect(finished.length).toBe(n - 1);
        }
      });
    }
  }

  it("terminates cleanly with jokers + reversing 8s in play", () => {
    for (const n of [2, 3, 4]) {
      for (let game = 0; game < 6; game++) {
        const players = Array.from({ length: n }, (_, k) => ({
          id: `p${k}`, name: `P${k}`, isCPU: true, difficulty: k % 2 ? "hard" : "normal",
        }));
        const s = createState({ players, options: { eightMode: "reverse", jokers: true } });
        autoSwapAndStart(s);
        const turns = playOut(s);
        expect(s.phase).toBe("over");
        expect(turns).toBeLessThan(6000);
        const withCards = s.players.filter((p) => p.hand.length || p.faceUp.length || p.faceDown.length);
        expect(withCards.length).toBe(1);
        expect(s.shitheadId).toBe(withCards[0].id);
      }
    }
  });

  it("makes real progress every turn — the turn counter never stalls mid-game", () => {
    const players = [
      { id: "a", name: "A", isCPU: true, difficulty: "hard" },
      { id: "b", name: "B", isCPU: true, difficulty: "normal" },
    ];
    const s = createState({ players });
    autoSwapAndStart(s);
    let i = 0;
    while (s.phase === "play" && i < 6000) {
      const before = s.turn;
      const action = planTurn(s);
      applyAction(s, action);
      // While the game is still live, every applied action must advance the turn.
      // Exempt: the terminal move that ends the game, and takeFaceUp (a pre-play
      // pickup of face-up cards into hand that doesn't consume the turn).
      if (s.phase === "play" && action.type !== "takeFaceUp") expect(s.turn).toBeGreaterThan(before);
      i++;
    }
    expect(s.phase).toBe("over");
  });
});

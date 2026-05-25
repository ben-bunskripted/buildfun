import { describe, it, expect } from "vitest";
import { planTurn } from "../../projects/benny-card-game/js/ai.js";
import {
  createMatch, startNextRound, beginTurn,
  drawFromDeck, drawFromDiscard, placeNewSet, addToSet, swapWildcard, discard,
  serialize, isNoWayOut, finalizeNoWayOut,
} from "../../projects/benny-card-game/js/game.js";
import { buildDeck } from "../../projects/benny-card-game/js/cards.js";

// Apply one CPU action through the real engine; return the engine result.
function applyAction(state, a) {
  switch (a.type) {
    case "drawDeck": return drawFromDeck(state);
    case "drawDiscard": return drawFromDiscard(state);
    case "play": return placeNewSet(state, a.arrangement);
    case "add": return addToSet(state, a.setId, a.arrangement);
    case "swap": return swapWildcard(state, a.setId, a.positionIndex, a.naturalCardId);
    case "discard": return discard(state, a.cardId);
    default: throw new Error("unknown action " + a.type);
  }
}

// Every card in play, wherever it lives, should be one of the 52 uniques.
function allCardIds(state) {
  const ids = [];
  for (const p of state.players) for (const c of p.hand) ids.push(c.id);
  for (const s of state.table) for (const c of s.cards) ids.push(c.card.id);
  for (const c of state.deck) ids.push(c.id);
  for (const c of state.discardPile) ids.push(c.id);
  return ids;
}

function makeCpuMatch(n, difficulty) {
  const names = Array.from({ length: n }, (_, i) => "CPU" + i);
  const s = createMatch(names, 0, {
    mode: "cpu",
    playerKinds: names.map(() => "cpu"),
    difficulties: names.map(() => difficulty),
  });
  startNextRound(s, { deck: buildDeck() });
  return s;
}

for (const difficulty of ["easy", "medium", "hard"]) {
  describe(`planTurn — ${difficulty}`, () => {
    it("produces only legal actions and never mutates state during planning", () => {
      const s = makeCpuMatch(4, difficulty);
      let opens = 0;
      let ended = false;

      for (let turn = 0; turn < 120 && !ended; turn++) {
        beginTurn(s);

        // Planning must be pure: state identical before and after planTurn.
        const before = JSON.stringify(serialize(s));
        const plan = planTurn(s, difficulty);
        expect(JSON.stringify(serialize(s))).toBe(before);

        expect(Array.isArray(plan)).toBe(true);
        expect(plan.length).toBeGreaterThan(0);

        for (const a of plan) {
          const r = applyAction(s, a);
          expect(r.ok, `action ${a.type} failed: ${r.reason}`).toBe(true);
          if (a.type === "play") opens++;
          if (r.wonRound) ended = true;
        }

        // Card conservation holds after every turn.
        const ids = allCardIds(s);
        expect(ids).toHaveLength(52);
        expect(new Set(ids).size).toBe(52);

        // The plan must end the turn: either the round ended, or the table
        // gained a discard and control passed on.
        if (!ended) {
          expect(s.phase).toBe("passing");
          if (isNoWayOut(s)) { finalizeNoWayOut(s); ended = true; }
        }
      }

      // Medium/hard CPUs should actually build melds, not just draw-and-dump.
      if (difficulty !== "easy") expect(opens).toBeGreaterThan(0);
    });
  });
}

describe("planTurn — dealer opening turn", () => {
  it("opens without drawing (the dealer's first turn has no draw)", () => {
    const s = makeCpuMatch(3, "hard");
    beginTurn(s); // dealer opening -> canAct
    const plan = planTurn(s, "hard");
    expect(plan[0].type).not.toBe("drawDeck");
    expect(plan[0].type).not.toBe("drawDiscard");
    expect(plan.at(-1).type).toBe("discard");
  });
});

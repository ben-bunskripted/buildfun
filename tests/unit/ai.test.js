import { describe, it, expect } from "vitest";
import { planTurn } from "../../projects/benny-card-game/js/ai.js";
import {
  createMatch, startNextRound, beginTurn,
  drawFromDeck, drawFromDiscard, placeNewSet, addToSet, swapWildcard, discard,
  serialize,
} from "../../projects/benny-card-game/js/game.js";
import { buildDeck } from "../../projects/benny-card-game/js/cards.js";
import { freshMatch, numberSet, runSet, natSlot, wildSlot, cards } from "../helpers.js";

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
        }
      }

      // Medium/hard CPUs should actually build melds, not just draw-and-dump.
      if (difficulty !== "easy") expect(opens).toBeGreaterThan(0);
    });
  });
}

// A non-dealer-opening turn fixture: current player (0) has opened, it's their
// turn, the deck has one inert card to draw, and matchEvents is already present
// (freshMatch populates it). Wildcard rank is K so plain spot cards aren't wild.
function turnFixture({ hand, table, deckTop = "7C", discardTop = "QH" }) {
  const s = freshMatch(["Me", "Opp"], { wildcardRank: "K" });
  s.dealerOpeningPending = false;
  s.currentPlayerIndex = 0;
  s.players[0].hasOpened = true;
  s.players[0].hand = cards(...hand);
  s.players[1].hand = cards("2C", "3C", "4C", "5C", "6C", "7H");
  s.table = table;
  s.deck = cards(deckTop);
  s.discardPile = cards(discardTop);
  return s;
}

describe("planTurn — hard: pick up a discard that extends a table meld", () => {
  it("picks up the top card when it can be added to an existing run", () => {
    // Run 5-6-7 of spades on the table; 8S sits on the discard. Our hand can't
    // open and shares no rank with 8S, so the ONLY reason to take it is the add.
    const s = turnFixture({
      hand: ["9H", "3D", "2C"],
      table: [runSet("S", 5, [natSlot("5S"), natSlot("6S"), natSlot("7S")], { id: "run1", ownerIndex: 0 })],
      discardTop: "8S",
    });
    const plan = planTurn(s, "hard");
    expect(plan[0].type).toBe("drawDiscard");
    expect(plan.some(a => a.type === "add" && a.arrangement.added.some(c => c.card.id === "8S"))).toBe(true);
  });
});

describe("planTurn — hard: swap a benny out instead of padding a set", () => {
  it("recovers the wildcard rather than adding the natural to the set", () => {
    // Number set 5S-5H-(wild=5). We hold 5D, which could either pad the set to
    // four OR swap the wildcard back. Out of endgame, the swap should win.
    const s = turnFixture({
      hand: ["5D", "9H", "3C"],
      table: [numberSet("5", [natSlot("5S"), natSlot("5H"), wildSlot("KC", "5")], { id: "set1", ownerIndex: 0 })],
    });
    const plan = planTurn(s, "hard");
    expect(plan.some(a => a.type === "swap" && a.naturalCardId === "5D")).toBe(true);
    expect(plan.some(a => a.type === "add" && a.arrangement.added.some(c => c.card.id === "5D"))).toBe(false);
  });

  it("takes back multiple bennies in one turn", () => {
    // Two number sets, each holding a wildcard; we hold a natural that swaps
    // each one. Both should come back in a single turn, not just one.
    const s = turnFixture({
      hand: ["5D", "8D", "9H"],
      table: [
        numberSet("5", [natSlot("5S"), natSlot("5H"), wildSlot("KC", "5")], { id: "set1", ownerIndex: 0 }),
        numberSet("8", [natSlot("8S"), natSlot("8H"), wildSlot("KD", "8")], { id: "set2", ownerIndex: 0 }),
      ],
    });
    const plan = planTurn(s, "hard");
    const swaps = plan.filter(a => a.type === "swap");
    expect(swaps.map(a => a.naturalCardId).sort()).toEqual(["5D", "8D"]);
  });

  it("still pads the set (sheds a card) when an opponent is about to go out", () => {
    const s = turnFixture({
      hand: ["5D", "9H", "3C"],
      table: [numberSet("5", [natSlot("5S"), natSlot("5H"), wildSlot("KC", "5")], { id: "set1", ownerIndex: 0 })],
    });
    s.players[1].hand = cards("2C"); // one card left → endgame threat
    s.players[1].hasOpened = true;
    const plan = planTurn(s, "hard");
    expect(plan.some(a => a.type === "add" && a.arrangement.added.some(c => c.card.id === "5D"))).toBe(true);
  });
});

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

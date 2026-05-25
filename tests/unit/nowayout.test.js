import { describe, it, expect } from "vitest";
import { isNoWayOut, finalizeNoWayOut } from "../../projects/benny-card-game/js/game.js";
import { card, numberSet, runSet, natSlot, wildSlot } from "../helpers.js";

// Build a state directly so we can pin the table / hands / wildcard precisely.
function state({ wild, table, hands }) {
  return {
    phase: "canAct",
    dealerOpeningPending: false,
    wildcardRank: wild,
    table,
    players: hands.map(h => ({ hand: h.map(card) })),
  };
}

// Maximal A-high run for a suit (values 2..14). K is the round wild, sitting at
// its own value 13; the Ace is high at value 14, so the value-1 end is the only
// opening — fillable by a wildcard, never by a natural.
const maximalRun = (suit) => runSet(suit, 2, [
  natSlot("2" + suit), natSlot("3" + suit), natSlot("4" + suit), natSlot("5" + suit),
  natSlot("6" + suit), natSlot("7" + suit), natSlot("8" + suit), natSlot("9" + suit),
  natSlot("10" + suit), natSlot("J" + suit), natSlot("Q" + suit),
  wildSlot("K" + suit, "K", suit),
  { card: card("A" + suit), isWild: false, representsRank: "A", representsSuit: suit },
], { id: "run-" + suit });

describe("isNoWayOut — guards", () => {
  it("never fires before anyone has opened (empty table)", () => {
    expect(isNoWayOut(state({
      wild: "2", table: [], hands: [["3H", "4H"], ["6H", "7H"]],
    }))).toBe(false);
  });
  it("never fires once the round is over", () => {
    const s = state({ wild: "2", table: [numberSet("5", [natSlot("5S")])], hands: [[], []] });
    s.phase = "roundOver";
    expect(isNoWayOut(s)).toBe(false);
  });
  it("never fires on the dealer's pending opening turn", () => {
    const s = state({ wild: "2", table: [numberSet("5", [natSlot("5S")])], hands: [[], []] });
    s.dealerOpeningPending = true;
    expect(isNoWayOut(s)).toBe(false);
  });
});

describe("isNoWayOut — the regression it was built for", () => {
  it("does NOT fire while any player still holds >=3 cards", () => {
    expect(isNoWayOut(state({
      wild: "2",
      table: [numberSet("5", [natSlot("5S"), natSlot("5H"), natSlot("5D"), natSlot("5C")])],
      hands: [["3H", "4H", "6H", "7H", "8H"], ["9H", "10H", "JH", "QH"]],
    }))).toBe(false);
  });
});

describe("isNoWayOut — true stalemates", () => {
  it("fires when every hand is <3 and the table is all capped number sets", () => {
    expect(isNoWayOut(state({
      wild: "2",
      table: [
        numberSet("5", [natSlot("5S"), natSlot("5H"), natSlot("5D"), natSlot("5C")], { id: "a" }),
        numberSet("9", [natSlot("9S"), natSlot("9H"), natSlot("9D"), natSlot("9C")], { id: "b" }),
      ],
      hands: [["3H", "4H"], ["6H", "7H"], ["8H", "10H"], ["JH", "QH"]],
    }))).toBe(true);
  });
  it("fires when every suit is a maximal run with all wilds pinned in place", () => {
    expect(isNoWayOut(state({
      wild: "K",
      table: ["S", "H", "D", "C"].map(maximalRun),
      hands: [[], [], [], []],
    }))).toBe(true);
  });
});

describe("isNoWayOut — escapes that must keep the round alive", () => {
  it("a loose wildcard can extend a maximal run -> not stuck", () => {
    expect(isNoWayOut(state({
      wild: "K",
      table: [maximalRun("S")], // KH/KD/KC are off-table (loose wilds)
      hands: [["2H", "3H"], ["4H", "5H"], ["6H", "7H"], ["8H", "9H"]],
    }))).toBe(false);
  });
  it("a swap-freeable wildcard (its natural is off-table) can be freed and added -> not stuck", () => {
    expect(isNoWayOut(state({
      wild: "K",
      table: [
        maximalRun("S"),
        numberSet("5", [natSlot("5S"), natSlot("5H"), natSlot("5D"), wildSlot("KC", "5", "C")], { id: "five" }),
      ],
      hands: [["2H", "3H"], ["4H", "6H"], ["7H", "8H"], ["9H", "10H"]],
    }))).toBe(false);
  });
  it("an incomplete (3-card) number set is always completable -> not stuck", () => {
    expect(isNoWayOut(state({
      wild: "2",
      table: [numberSet("5", [natSlot("5S"), natSlot("5H"), natSlot("5D")])],
      hands: [["3H", "4H"], ["6H", "7H"]],
    }))).toBe(false);
  });
});

describe("finalizeNoWayOut", () => {
  it("scores every hand with no winner and stamps the round noWayOut", () => {
    const s = state({
      wild: "K",
      table: [numberSet("5", [natSlot("5S"), natSlot("5H"), natSlot("5D"), natSlot("5C")])],
      hands: [["3H", "4H"], ["KH"]], // 3+4=7 ; wild=15
    });
    s.players.forEach(p => { p.score = 0; });
    s.round = 3;
    s.dealerIndex = 0;
    s.matchEvents = { opens: [], discards: [], rounds: [], setsPlayed: [] };
    finalizeNoWayOut(s);
    expect(s.roundWinner).toBeNull();
    expect(s.perRoundScores).toEqual([7, 15]);
    expect(s.phase).toBe("roundOver");
    expect(s.roundHistory.at(-1).noWayOut).toBe(true);
    expect(s.matchEvents.rounds.at(-1).noWayOut).toBe(true);
  });
});

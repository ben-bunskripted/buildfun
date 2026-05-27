import { describe, it, expect } from "vitest";
import { isNoWayOut, finalizeNoWayOut } from "../../projects/benny-card-game/js/game.js";
import { freshMatch, numberSet, natSlot, wildSlot, cards } from "../helpers.js";

// The one true deadlock (wildcard rank = K): four complete four-of-a-kind
// number sets, each padded with one buried king. Every king is unswappable
// (its set already holds all four natural suits, so no natural can swap in)
// and no off-table natural matches any set's rank, so nothing extends. Both
// hands sit at <=2 unplayable cards. Tweak via opts to break one criterion.
function deadlock(opts = {}) {
  const draws = opts.draws ?? 3;
  const hands = opts.hands ?? [cards("AS", "2S"), cards("AH", "2H")];
  const s = freshMatch(["P0", "P1"], { wildcardRank: "K" });
  s.dealerOpeningPending = false;
  s.phase = "passing";
  s.players[0].hand = hands[0];
  s.players[1].hand = hands[1];
  s.players.forEach(p => { p.hasOpened = true; p.drawsThisRound = draws; });
  s.table = opts.table ?? [
    numberSet("5", [natSlot("5S"), natSlot("5H"), natSlot("5D"), natSlot("5C"), wildSlot("KS", "5")], { id: "s5" }),
    numberSet("6", [natSlot("6S"), natSlot("6H"), natSlot("6D"), natSlot("6C"), wildSlot("KH", "6")], { id: "s6" }),
    numberSet("7", [natSlot("7S"), natSlot("7H"), natSlot("7D"), natSlot("7C"), wildSlot("KD", "7")], { id: "s7" }),
    numberSet("8", [natSlot("8S"), natSlot("8H"), natSlot("8D"), natSlot("8C"), wildSlot("KC", "8")], { id: "s8" }),
  ];
  return s;
}

describe("isNoWayOut — guards", () => {
  it("never fires once the round is already over", () => {
    const s = deadlock();
    s.phase = "roundOver";
    expect(isNoWayOut(s)).toBe(false);
  });
  it("never fires on the dealer's opening turn", () => {
    const s = deadlock();
    s.dealerOpeningPending = true;
    expect(isNoWayOut(s)).toBe(false);
  });
  it("never fires before anything is on the table", () => {
    const s = deadlock();
    s.table = [];
    expect(isNoWayOut(s)).toBe(false);
  });
});

describe("isNoWayOut — the 3-cycle gate", () => {
  it("fires once every player has had >= 3 draw-and-discard cycles", () => {
    expect(isNoWayOut(deadlock({ draws: 3 }))).toBe(true);
  });
  it("holds off while any player is short of 3 cycles", () => {
    expect(isNoWayOut(deadlock({ draws: 2 }))).toBe(false);
  });
  it("holds off if only one player is short", () => {
    const s = deadlock({ draws: 3 });
    s.players[1].drawsThisRound = 1;
    expect(isNoWayOut(s)).toBe(false);
  });
});

describe("isNoWayOut — each criterion keeps the round alive", () => {
  it("1: someone can still open (a hand holds > 2 cards)", () => {
    expect(isNoWayOut(deadlock({ hands: [cards("AS", "2S", "3S"), cards("AH", "2H")] }))).toBe(false);
  });

  it("2: a wildcard is still reachable (a king sits off-table)", () => {
    // Drop the king out of the 5-set and into a hand — now KS is off-table.
    const s = deadlock({ hands: [cards("KS", "AS"), cards("AH", "2H")] });
    s.table[0] = numberSet("5", [natSlot("5S"), natSlot("5H"), natSlot("5D"), natSlot("5C")], { id: "s5" });
    expect(isNoWayOut(s)).toBe(false);
  });

  it("3: a buried king can be swapped free (its set is missing a suit)", () => {
    // 5-set holds only S/H/D naturals + the king, so an off-table 5C swaps in.
    const s = deadlock();
    s.table[0] = numberSet("5", [natSlot("5S"), natSlot("5H"), natSlot("5D"), wildSlot("KS", "5")], { id: "s5" });
    expect(isNoWayOut(s)).toBe(false);
  });

  it("4: a reachable natural still extends a meld", () => {
    // An incomplete 9-set: off-table 9s extend it with a plain natural.
    const s = deadlock();
    s.table.push(numberSet("9", [natSlot("9S"), natSlot("9H"), natSlot("9D")], { id: "s9" }));
    expect(isNoWayOut(s)).toBe(false);
  });
});

describe("finalizeNoWayOut", () => {
  it("scores every hand with no winner and stamps the round noWayOut", () => {
    const s = deadlock();
    const before = s.players.map(p => p.score);
    finalizeNoWayOut(s);

    expect(s.roundWinner).toBe(null);
    expect(s.phase).toBe("roundOver");
    expect(s.perRoundScores.every(v => v > 0)).toBe(true);
    s.players.forEach((p, i) => expect(p.score).toBe(before[i] + s.perRoundScores[i]));
    expect(s.roundHistory.at(-1).noWayOut).toBe(true);
    expect(s.roundHistory.at(-1).winnerIdx).toBe(null);
    expect(s.matchEvents.rounds.at(-1).noWayOut).toBe(true);
  });
});

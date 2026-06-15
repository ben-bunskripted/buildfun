import { describe, it, expect } from "vitest";
import { evaluateMatch, ACHIEVEMENTS, PROGRESS_ACHIEVEMENTS } from "../../projects/benny-card-game/js/achievements.js";
import { TOTAL_ROUNDS } from "../../projects/benny-card-game/js/game.js";

// Minimal summary scaffold; override fields per test.
function summary(over = {}) {
  return {
    mode: "cpu",
    totalPlayers: 2,
    players: [
      { idx: 0, name: "P0", finalScore: 0, isWinner: true, position: 1, kind: "human" },
      { idx: 1, name: "P1", finalScore: 30, isWinner: false, position: 2, kind: "cpu" },
    ],
    roundHistory: [{ round: 1, winnerIdx: 0, cumulative: [0, 30] }],
    matchEvents: { opens: [], discards: [], rounds: [{ round: 1, winnerIdx: 0, openedOrder: [0] }], setsPlayed: [] },
    ...over,
  };
}

const earnedFor = (idx, sum) => evaluateMatch(sum, null)[idx];

describe("score achievements", () => {
  it("untouchable for a 0-point finish", () => {
    expect(earnedFor(0, summary())).toContain("untouchable");
  });
  it("whisker for under 10 (but above 0)", () => {
    const ids = earnedFor(0, summary({ players: [{ idx: 0, name: "P0", finalScore: 7, isWinner: true, position: 1 }, { idx: 1, name: "P1", finalScore: 30, isWinner: false, position: 2 }] }));
    expect(ids).toContain("whisker");
    expect(ids).not.toContain("untouchable");
  });
  it("train_wreck for over 300", () => {
    const ids = earnedFor(1, summary({ players: [{ idx: 0, name: "P0", finalScore: 0, isWinner: true, position: 1 }, { idx: 1, name: "P1", finalScore: 350, isWinner: false, position: 2 }] }));
    expect(ids).toContain("train_wreck");
  });
});

describe("match-shape achievements", () => {
  it("wire_to_wire when the winner led at every round-end", () => {
    expect(earnedFor(0, summary())).toContain("wire_to_wire");
  });
  it("photo_finish when the winning margin is <= 5", () => {
    const sum = summary({
      players: [
        { idx: 0, name: "P0", finalScore: 20, isWinner: true, position: 1 },
        { idx: 1, name: "P1", finalScore: 23, isWinner: false, position: 2 },
      ],
      roundHistory: [{ round: 1, winnerIdx: 0, cumulative: [20, 23] }],
    });
    expect(earnedFor(0, sum)).toContain("photo_finish");
  });
});

describe("card-detail achievements", () => {
  it("whoopsie when a player discards the wildcard rank", () => {
    const sum = summary({ matchEvents: { opens: [], discards: [{ playerIdx: 0, wasWild: true }], rounds: [{ winnerIdx: 0, openedOrder: [0] }], setsPlayed: [] } });
    expect(earnedFor(0, sum)).toContain("whoopsie");
  });
  it("are suppressed in scoring mode (no card detail)", () => {
    const sum = summary({ mode: "scoring", matchEvents: { opens: [], discards: [{ playerIdx: 0, wasWild: true }], rounds: [{ winnerIdx: 0, openedOrder: null }], setsPlayed: [] } });
    expect(earnedFor(0, sum)).not.toContain("whoopsie");
  });
});

describe("wild-label-off achievements", () => {
  it("flying_blind / sixth_sense / minds_eye when the wild label was hidden", () => {
    const ids = earnedFor(0, summary({ hideWildLabel: true }));
    expect(ids).toContain("flying_blind"); // winner
    expect(ids).toContain("sixth_sense");  // won round 1
    expect(ids).toContain("minds_eye");    // finalScore 0 < 20
  });
  it("are NOT earned when the wild label was shown", () => {
    const ids = earnedFor(0, summary({ hideWildLabel: false }));
    expect(ids).not.toContain("flying_blind");
    expect(ids).not.toContain("sixth_sense");
    expect(ids).not.toContain("minds_eye");
  });
  it("flying_blind needs the win; a hidden-label loser doesn't get it", () => {
    const ids = earnedFor(1, summary({ hideWildLabel: true }));
    expect(ids).not.toContain("flying_blind"); // P1 lost
    expect(ids).not.toContain("sixth_sense");  // P1 won no rounds
  });
});

describe("round-dominance achievements", () => {
  // A full match plays all TOTAL_ROUNDS rounds; sweep() wins every one for P0.
  const fullHistory = (winners) => winners.map((winnerIdx, i) => ({
    round: i + 1, winnerIdx, cumulative: [0, 30 * (i + 1)], scores: [0, 30],
  }));
  const sweep = (over) => summary({
    roundHistory: fullHistory(Array(TOTAL_ROUNDS).fill(0)),
    ...over,
  });
  it("clean_sweep when the player wins every round of a full match", () => {
    expect(earnedFor(0, sweep())).toContain("clean_sweep");
  });
  it("no clean_sweep if a single round was lost", () => {
    const winners = Array(TOTAL_ROUNDS).fill(0);
    winners[1] = 1; // P1 takes round 2
    const sum = sweep({ roundHistory: fullHistory(winners) });
    expect(earnedFor(0, sum)).not.toContain("clean_sweep");
  });
  it("no clean_sweep for an incomplete match, even if every played round was won", () => {
    const sum = sweep({ roundHistory: fullHistory(Array(TOTAL_ROUNDS - 1).fill(0)) });
    expect(earnedFor(0, sum)).not.toContain("clean_sweep");
  });
  it("magnificent_seven at 7 round wins, unstoppable at 5 straight", () => {
    const rounds = Array.from({ length: 7 }, (_, i) => ({ round: i + 1, winnerIdx: 0, cumulative: [0, 0] }));
    const ids = earnedFor(0, summary({ roundHistory: rounds }));
    expect(ids).toContain("magnificent_seven");
    expect(ids).toContain("unstoppable");
  });
  it("opening_act when first to open in 5 rounds", () => {
    const rounds = Array.from({ length: 5 }, (_, i) => ({ round: i + 1, winnerIdx: 1, openedOrder: [0, 1] }));
    const sum = summary({ matchEvents: { opens: [], discards: [], rounds, setsPlayed: [], pickups: [] } });
    expect(earnedFor(0, sum)).toContain("opening_act");
  });
});

describe("card-play achievements", () => {
  it("wild_thing when going out with 3+ table wilds", () => {
    const sum = summary({ matchEvents: { opens: [], discards: [], rounds: [{ winnerIdx: 0, winnerWildsOnTable: 3 }], setsPlayed: [], pickups: [] } });
    expect(earnedFor(0, sum)).toContain("wild_thing");
  });
  it("magpie after 5 discard pickups", () => {
    const pickups = Array.from({ length: 5 }, () => ({ playerIdx: 0, rank: "5", suit: "H" }));
    const sum = summary({ matchEvents: { opens: [], discards: [], rounds: [{ winnerIdx: 0, openedOrder: [0] }], setsPlayed: [], pickups } });
    expect(earnedFor(0, sum)).toContain("magpie");
  });
  it("survivor for the smallest hit in a No Way Out round", () => {
    const sum = summary({ roundHistory: [{ round: 1, winnerIdx: null, noWayOut: true, scores: [12, 40], cumulative: [12, 40] }] });
    expect(earnedFor(0, sum)).toContain("survivor");
    const sum2 = summary({ roundHistory: [{ round: 1, winnerIdx: null, noWayOut: true, scores: [40, 12], cumulative: [40, 12] }] });
    expect(earnedFor(0, sum2)).not.toContain("survivor");
  });
});

describe("lifetime/meta achievements", () => {
  const profiles = (matchHistory) => ({ players: { p0: { matchHistory, achievements: [] } } });
  it("champion on a 10th win in the mode", () => {
    const hist = Array.from({ length: 9 }, () => ({ mode: "cpu", position: 1 }));
    expect(evaluateMatch(summary(), profiles(hist))[0]).toContain("champion");
  });
  it("seasoned on a 25th match in the mode", () => {
    const hist = Array.from({ length: 24 }, () => ({ mode: "cpu", position: 3 }));
    expect(evaluateMatch(summary(), profiles(hist))[0]).toContain("seasoned");
  });
  it("on_a_roll after 2 prior straight wins (this win makes 3)", () => {
    const hist = [{ mode: "cpu", position: 1 }, { mode: "cpu", position: 1 }, { mode: "cpu", position: 2 }];
    expect(evaluateMatch(summary(), profiles(hist))[0]).toContain("on_a_roll");
  });
  it("on_a_roll breaks the streak on an intervening loss", () => {
    const hist = [{ mode: "cpu", position: 1 }, { mode: "cpu", position: 2 }, { mode: "cpu", position: 1 }];
    expect(evaluateMatch(summary(), profiles(hist))[0]).not.toContain("on_a_roll");
  });
});

describe("registry sanity", () => {
  it("every achievement has a unique id and an evaluate fn", () => {
    const ids = ACHIEVEMENTS.map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ACHIEVEMENTS) expect(typeof a.evaluate).toBe("function");
  });
  it("progress achievements declare a numeric target", () => {
    for (const a of PROGRESS_ACHIEVEMENTS) expect(typeof a.target).toBe("number");
  });
  it("a broken evaluator never throws out of evaluateMatch", () => {
    // photo_finish etc. read summary.players via filter — pass a degenerate
    // single-player summary to make sure nothing escapes the try/catch.
    expect(() => evaluateMatch(summary({ totalPlayers: 1, players: [{ idx: 0, name: "P0", finalScore: 0, isWinner: true, position: 1 }] }), null)).not.toThrow();
  });
});

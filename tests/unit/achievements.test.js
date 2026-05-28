import { describe, it, expect } from "vitest";
import { evaluateMatch, ACHIEVEMENTS, PROGRESS_ACHIEVEMENTS } from "../../projects/benny-card-game/js/achievements.js";

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

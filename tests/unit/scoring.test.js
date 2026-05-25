import { describe, it, expect } from "vitest";
import {
  createScoringMatch, startScoringRound, submitScoringRound,
  isScoringMatchOver, advanceScoringRound, scoringWinnerIndex,
} from "../../projects/benny-card-game/js/scoring.js";
import { TOTAL_ROUNDS, WILDCARD_ORDER } from "../../projects/benny-card-game/js/game.js";

const setup = () => startScoringRound(createScoringMatch(["A", "B", "C"], 0));

describe("scoring match lifecycle", () => {
  it("starts round 1 with the first wildcard rank", () => {
    const s = setup();
    expect(s.round).toBe(1);
    expect(s.wildcardRank).toBe(WILDCARD_ORDER[0]);
    expect(s.phase).toBe("entering");
  });

  it("accumulates scores and records history on submit", () => {
    const s = setup();
    const r = submitScoringRound(s, 0, [0, 12, 7]);
    expect(r.ok).toBe(true);
    expect(s.players.map(p => p.score)).toEqual([0, 12, 7]);
    expect(s.roundWinner).toBe(0);
    expect(s.roundHistory).toHaveLength(1);
    expect(s.phase).toBe("roundOver");
  });

  it("advances the dealer clockwise and starts the next round", () => {
    const s = setup();
    submitScoringRound(s, 0, [0, 1, 2]);
    advanceScoringRound(s);
    expect(s.round).toBe(2);
    expect(s.dealerIndex).toBe(1);
    expect(s.wildcardRank).toBe(WILDCARD_ORDER[1]);
  });
});

describe("submitScoringRound validation", () => {
  it("rejects scoring outside the entering phase", () => {
    const s = setup();
    submitScoringRound(s, 0, [0, 1, 2]);
    expect(submitScoringRound(s, 0, [0, 1, 2]).ok).toBe(false);
  });
  it("requires a valid winner index", () => {
    expect(submitScoringRound(setup(), 9, [0, 1, 2]).ok).toBe(false);
    expect(submitScoringRound(setup(), null, [0, 1, 2]).ok).toBe(false);
  });
  it("requires the winner to score zero", () => {
    expect(submitScoringRound(setup(), 0, [3, 1, 2]).ok).toBe(false);
  });
  it("rejects a mis-sized or invalid score array", () => {
    expect(submitScoringRound(setup(), 0, [0, 1]).ok).toBe(false);
    expect(submitScoringRound(setup(), 0, [0, -1, 2]).ok).toBe(false);
    expect(submitScoringRound(setup(), 0, [0, 1.5, 2]).ok).toBe(false);
    expect(submitScoringRound(setup(), 0, [0, 1000, 2]).ok).toBe(false);
  });
});

describe("match end + winner", () => {
  it("is over only after the final round resolves", () => {
    const s = createScoringMatch(["A", "B"], 0);
    for (let r = 1; r <= TOTAL_ROUNDS; r++) {
      startScoringRound(s);
      expect(isScoringMatchOver(s)).toBe(false);
      submitScoringRound(s, 0, [0, 5]);
    }
    expect(isScoringMatchOver(s)).toBe(true);
  });
  it("lowest cumulative score wins (ties to lowest index)", () => {
    const s = createScoringMatch(["A", "B", "C"], 0);
    s.players[0].score = 40;
    s.players[1].score = 15;
    s.players[2].score = 15;
    expect(scoringWinnerIndex(s)).toBe(1);
  });
});

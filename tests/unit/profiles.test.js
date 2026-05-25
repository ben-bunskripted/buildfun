import { describe, it, expect } from "vitest";
import { buildMatchSummary, recordMatch, ensureProfile, keyFor } from "../../projects/benny-card-game/js/profiles.js";

function finishedState() {
  return {
    mode: "cpu",
    players: [
      { name: "Ann", kind: "human", score: 0 },
      { name: "Bot", kind: "cpu", score: 50 },
    ],
    dealerIndex: 0,
    roundHistory: [
      { round: 1, winnerIdx: 0, scores: [0, 50], cumulative: [0, 50] },
    ],
    matchEvents: { opens: [{ round: 1, playerIdx: 0 }], discards: [], rounds: [{ round: 1, winnerIdx: 0, openedOrder: [0] }], setsPlayed: [] },
  };
}

describe("keyFor / ensureProfile", () => {
  it("folds casing + whitespace onto one key", () => {
    expect(keyFor("  Ben ")).toBe("ben");
    const profiles = { version: 1, players: {} };
    const a = ensureProfile(profiles, "Ben");
    const b = ensureProfile(profiles, "BEN ");
    expect(a).toBe(b);
    expect(b.aliases).toContain("BEN");
  });
});

describe("buildMatchSummary", () => {
  it("ranks by score and flags the winner / dealer / rounds won", () => {
    const sum = buildMatchSummary(finishedState());
    expect(sum.totalPlayers).toBe(2);
    expect(sum.players[0]).toMatchObject({ name: "Ann", position: 1, isWinner: true, isDealer: true, roundsWon: 1 });
    expect(sum.players[1]).toMatchObject({ name: "Bot", position: 2, isWinner: false });
  });
});

describe("recordMatch", () => {
  it("folds the human's stats, skips CPUs, and unlocks earned achievements", () => {
    const profiles = { version: 1, players: {} };
    const sum = buildMatchSummary(finishedState());
    const { newUnlocks } = recordMatch(profiles, sum);

    const ann = profiles.players[keyFor("Ann")];
    expect(ann).toBeTruthy();
    expect(ann.stats.matchesPlayed).toBe(1);
    expect(ann.stats.matchesWon).toBe(1);
    expect(ann.stats.roundsWon).toBe(1);
    expect(profiles.players[keyFor("Bot")]).toBeUndefined(); // CPUs get no profile

    expect(newUnlocks[0]).toContain("untouchable"); // finished on 0 points
  });

  it("does not double-count achievements already earned in the same mode", () => {
    const profiles = { version: 1, players: {} };
    const sum = buildMatchSummary(finishedState());
    recordMatch(profiles, sum);
    const before = profiles.players[keyFor("Ann")].achievements.length;
    const { newUnlocks } = recordMatch(profiles, buildMatchSummary(finishedState()));
    expect(newUnlocks[0]).toBeUndefined();
    expect(profiles.players[keyFor("Ann")].achievements.length).toBe(before);
  });
});

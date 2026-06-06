import { describe, it, expect } from "vitest";
import {
  evaluate, evaluateProgress, PROGRESS_ACHIEVEMENTS, ACHIEVEMENTS, achievementById,
} from "../../projects/shithead/js/achievements.js";

describe("evaluate (one-shot achievements)", () => {
  it("awards an action achievement from the live summary", () => {
    expect(evaluate({ twos: 1 })).toContain("reset_button");
    expect(evaluate({ jokers: 2 })).toContain("jokers_wild");
    expect(evaluate({ deflects: 1 })).toContain("no_laughing");
  });
  it("only awards place-based achievements on the right finish", () => {
    expect(evaluate({ place: 1 })).toContain("first_blood");
    expect(evaluate({ place: 2 })).not.toContain("first_blood");
    expect(evaluate({ isShithead: true })).toContain("the_shithead");
  });
  it("every achievement has an icon and resolves by id", () => {
    for (const a of ACHIEVEMENTS) {
      expect(a.icon).toBeTruthy();
      expect(achievementById(a.id)).toBe(a);
    }
  });
});

describe("evaluateProgress (lifetime goals)", () => {
  const prof = {
    stats: { games: 30, wins: 12, bestStreak: 4 },
    progress: { burns: 10, jokers: 20 },
  };
  it("clamps the value to the target and flags unlocked", () => {
    const byId = Object.fromEntries(evaluateProgress(prof).map((i) => [i.def.id, i]));
    expect(byId.veteran.value).toBe(25);        // clamped down from 30 games
    expect(byId.veteran.unlocked).toBe(true);
    expect(byId.champion.value).toBe(10);       // 12 wins clamped to 10 target
    expect(byId.arsonist.value).toBe(10);
    expect(byId.arsonist.unlocked).toBe(false);
    expect(byId.court_jester.value).toBe(15);   // clamped down from 20 jokers
  });
  it("tolerates a profile missing fields without throwing", () => {
    const items = evaluateProgress({ stats: {}, progress: {} });
    expect(items.every((i) => i.value === 0 && !i.unlocked)).toBe(true);
  });
  it("each progress def resolves by id and has an icon", () => {
    for (const def of PROGRESS_ACHIEVEMENTS) {
      expect(def.icon).toBeTruthy();
      expect(achievementById(def.id)).toBe(def);
    }
  });
});

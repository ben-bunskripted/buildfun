import { describe, it, expect } from "vitest";
import {
  evaluate, evaluateProgress, PROGRESS_ACHIEVEMENTS, ACHIEVEMENTS, achievementById,
  totalAchievementCount, countUnlocked,
} from "../../projects/shithead/js/achievements.js";

describe("evaluate (one-shot achievements)", () => {
  it("awards an action achievement from the live summary", () => {
    expect(evaluate({ twos: 1 })).toContain("reset_button");
    expect(evaluate({ jokers: 2 })).toContain("jokers_wild");
    expect(evaluate({ deflects: 1 })).toContain("no_laughing");
    expect(evaluate({ eights: 1 })).toContain("spin_cycle");
    expect(evaluate({ bigPlay: 3 })).toContain("hat_trick");
    expect(evaluate({ bigPlay: 2 })).not.toContain("hat_trick");
    expect(evaluate({ maxPickup: 12 })).toContain("dumpster_dive");
  });
  it("only awards place-based achievements on the right finish", () => {
    expect(evaluate({ place: 1 })).toContain("first_blood");
    expect(evaluate({ place: 2 })).not.toContain("first_blood");
    expect(evaluate({ isShithead: true })).toContain("the_shithead");
    // survivor / comeback need the win AND a pickup of the right size
    expect(evaluate({ place: 1, pickups: 1 })).toContain("survivor");
    expect(evaluate({ place: 2, pickups: 1 })).not.toContain("survivor");
    expect(evaluate({ place: 1, maxPickup: 10 })).toContain("comeback_kid");
    expect(evaluate({ place: 1, maxPickup: 9 })).not.toContain("comeback_kid");
  });
  it("off_the_hook needs surviving a 3+ player table", () => {
    expect(evaluate({ isShithead: false, total: 3 })).toContain("off_the_hook");
    expect(evaluate({ isShithead: false, total: 2 })).not.toContain("off_the_hook");
    expect(evaluate({ isShithead: true, total: 4 })).not.toContain("off_the_hook");
  });
  it("every achievement has an icon, a valid tier, and resolves by id", () => {
    const tiers = new Set(["easy", "medium", "hard", "rare"]);
    for (const a of ACHIEVEMENTS) {
      expect(a.icon).toBeTruthy();
      expect(tiers.has(a.tier)).toBe(true);
      expect(achievementById(a.id)).toBe(a);
    }
  });
  it("has unique ids across one-shot and progress achievements", () => {
    const ids = [...ACHIEVEMENTS, ...PROGRESS_ACHIEVEMENTS].map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("keeps a balanced tier mix (~30/40/25/5)", () => {
    const all = [...ACHIEVEMENTS, ...PROGRESS_ACHIEVEMENTS];
    const pct = (t) => all.filter((a) => a.tier === t).length / all.length;
    expect(pct("easy")).toBeGreaterThanOrEqual(0.20);
    expect(pct("easy")).toBeLessThanOrEqual(0.40);
    expect(pct("medium")).toBeGreaterThanOrEqual(0.30);
    expect(pct("medium")).toBeLessThanOrEqual(0.50);
    expect(pct("hard")).toBeLessThanOrEqual(0.35);
    expect(pct("rare")).toBeLessThanOrEqual(0.12);
    expect(pct("rare")).toBeGreaterThan(0);
  });
});

describe("achievement totals + counts (gold bar)", () => {
  it("totalAchievementCount sums one-shot and progress", () => {
    expect(totalAchievementCount()).toBe(ACHIEVEMENTS.length + PROGRESS_ACHIEVEMENTS.length);
  });
  it("countUnlocked tallies valid one-shot ids plus unlocked progress", () => {
    const prof = {
      achievements: ["first_blood", "reset_button", "retired_old_id"],
      stats: { games: 30, wins: 1, bestStreak: 1 },
      progress: { burns: 0, jokers: 0 },
    };
    // 2 valid one-shot (the retired id is ignored) + veteran unlocked (30 >= 25)
    expect(countUnlocked(prof)).toBe(3);
  });
  it("countUnlocked is 0 for an unknown / empty profile", () => {
    expect(countUnlocked(null)).toBe(0);
    expect(countUnlocked({ achievements: [], stats: {}, progress: {} })).toBe(0);
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

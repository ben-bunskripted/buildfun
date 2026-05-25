import { describe, it, expect } from "vitest";
import { randomInt, shuffleInPlace, pickRandom } from "../../projects/benny-card-game/js/rng.js";

describe("randomInt", () => {
  it("rejects non-positive / non-integer bounds", () => {
    expect(() => randomInt(0)).toThrow();
    expect(() => randomInt(-3)).toThrow();
    expect(() => randomInt(2.5)).toThrow();
  });

  it("always returns 0 for bound 1", () => {
    for (let i = 0; i < 50; i++) expect(randomInt(1)).toBe(0);
  });

  it("stays within [0, max) across many draws", () => {
    const max = 7;
    const seen = new Set();
    for (let i = 0; i < 5000; i++) {
      const n = randomInt(max);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(max);
      expect(Number.isInteger(n)).toBe(true);
      seen.add(n);
    }
    // With 5000 draws over 7 buckets every value should appear (no dead bucket).
    expect(seen.size).toBe(max);
  });
});

describe("shuffleInPlace", () => {
  it("returns the same array reference and preserves the multiset", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    const ref = shuffleInPlace(arr);
    expect(ref).toBe(arr);
    expect([...arr].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("handles empty and single-element arrays", () => {
    expect(shuffleInPlace([])).toEqual([]);
    expect(shuffleInPlace([42])).toEqual([42]);
  });

  it("actually reorders most of the time", () => {
    let changed = 0;
    for (let t = 0; t < 20; t++) {
      const base = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
      const copy = base.slice();
      shuffleInPlace(copy);
      if (copy.some((v, i) => v !== base[i])) changed++;
    }
    expect(changed).toBeGreaterThan(15);
  });
});

describe("pickRandom", () => {
  it("returns undefined for an empty array", () => {
    expect(pickRandom([])).toBeUndefined();
  });
  it("returns an element of the array", () => {
    const arr = ["a", "b", "c"];
    for (let i = 0; i < 100; i++) expect(arr).toContain(pickRandom(arr));
  });
});

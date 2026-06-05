import { describe, it, expect } from "vitest";
import * as R from "../../projects/shithead/js/rules.js";

const C = (id) => ({ id, rank: id.slice(0, -1), suit: id.slice(-1) });
const cs = (...ids) => ids.map(C);
const opts = (o = {}) => ({ ...R.defaultOptions(), ...o });

describe("requirement / comparisonCard", () => {
  it("empty pile is free", () => {
    expect(R.requirement([], opts())).toEqual({ kind: "free" });
  });
  it("a 2 on top resets to free", () => {
    expect(R.requirement(cs("KS", "2H"), opts())).toEqual({ kind: "free" });
  });
  it("a 7 demands lower-or-equal", () => {
    expect(R.requirement(cs("7S"), opts())).toEqual({ kind: "max7" });
  });
  it("otherwise demands a minimum value", () => {
    expect(R.requirement(cs("9S"), opts())).toEqual({ kind: "min", value: 9 });
  });
  it("invisible 8 is seen through to the card below", () => {
    expect(R.requirement(cs("KS", "8H", "8D"), opts())).toEqual({ kind: "min", value: 13 });
  });
  it("a pile of only 8s (invisible) is free", () => {
    expect(R.requirement(cs("8H", "8D"), opts())).toEqual({ kind: "free" });
  });
  it("skip-mode 8 is the comparison card itself", () => {
    expect(R.requirement(cs("8H"), opts({ eightMode: "skip" }))).toEqual({ kind: "min", value: 8 });
  });
});

describe("canPlayRank", () => {
  const o = opts();
  it("2 and 10 always play", () => {
    const req = { kind: "min", value: 14 };
    expect(R.canPlayRank("2", req, o)).toBe(true);
    expect(R.canPlayRank("10", req, o)).toBe(true);
  });
  it("invisible 8 always plays, skip-mode 8 must climb", () => {
    const req = { kind: "min", value: 12 };
    expect(R.canPlayRank("8", req, o)).toBe(true);
    expect(R.canPlayRank("8", req, opts({ eightMode: "skip" }))).toBe(false);
  });
  it("min requirement compares climbing value", () => {
    const req = { kind: "min", value: 9 };
    expect(R.canPlayRank("9", req, o)).toBe(true);
    expect(R.canPlayRank("J", req, o)).toBe(true);
    expect(R.canPlayRank("8", req, opts({ eightMode: "skip" }))).toBe(false);
    expect(R.canPlayRank("6", req, o)).toBe(false);
  });
  it("max7 requirement only allows <=7 (plus powers)", () => {
    const req = { kind: "max7" };
    expect(R.canPlayRank("7", req, o)).toBe(true);
    expect(R.canPlayRank("3", req, o)).toBe(true);
    expect(R.canPlayRank("9", req, o)).toBe(false);
    expect(R.canPlayRank("2", req, o)).toBe(true);
    expect(R.canPlayRank("10", req, o)).toBe(true);
  });
});

describe("burnsPile", () => {
  it("a 10 burns", () => {
    expect(R.burnsPile(cs("10S"), cs("4S", "10S"), opts())).toBe(true);
  });
  it("four-of-a-kind across turns burns when option on", () => {
    expect(R.burnsPile(cs("9C"), cs("9S", "9H", "9D", "9C"), opts())).toBe(true);
  });
  it("four-of-a-kind across turns does NOT burn when option off", () => {
    const o = opts({ fourKindAcrossTurns: false });
    expect(R.burnsPile(cs("9C"), cs("9S", "9H", "9D", "9C"), o)).toBe(false);
    // ...but all four in one play still burns
    expect(R.burnsPile(cs("9S", "9H", "9D", "9C"), cs("9S", "9H", "9D", "9C"), o)).toBe(true);
  });
  it("three of a kind does not burn", () => {
    expect(R.burnsPile(cs("9D"), cs("9S", "9H", "9D"), opts())).toBe(false);
  });
});

describe("skipCount", () => {
  it("counts 8s only in skip mode", () => {
    expect(R.skipCount(cs("8S", "8H"), opts({ eightMode: "skip" }))).toBe(2);
    expect(R.skipCount(cs("8S", "8H"), opts())).toBe(0);
  });
});

describe("playableRanks / hasLegalPlay", () => {
  it("reports the distinct legal ranks in a zone", () => {
    const hand = cs("4S", "9H", "10C", "2D");
    const ranks = R.playableRanks(hand, cs("8S"), opts()).sort();
    // vs an 8 (invisible→free? no, 8 is comparison only when invisible sees-through;
    // here pile is a single 8 invisible → free), everything is legal
    expect(ranks).toEqual(["10", "2", "4", "9"].sort());
  });
  it("hasLegalPlay false when nothing beats a high pile", () => {
    expect(R.hasLegalPlay(cs("4S", "5H"), cs("KS"), opts())).toBe(false);
    expect(R.hasLegalPlay(cs("4S", "2H"), cs("KS"), opts())).toBe(true);
  });
});

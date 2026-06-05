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
  it("a 7 demands lower-or-equal (when the 7 power is on)", () => {
    expect(R.requirement(cs("7S"), opts({ sevenPower: true }))).toEqual({ kind: "max7" });
  });
  it("a 7 is an ordinary climbing card when the 7 power is off (default)", () => {
    expect(R.requirement(cs("7S"), opts())).toEqual({ kind: "min", value: 7 });
  });
  it("otherwise demands a minimum value", () => {
    expect(R.requirement(cs("9S"), opts())).toEqual({ kind: "min", value: 9 });
  });
  it("invisible 8 is seen through to the card below", () => {
    expect(R.requirement(cs("KS", "8H", "8D"), opts({ eightMode: "invisible" }))).toEqual({ kind: "min", value: 13 });
  });
  it("a pile of only 8s (invisible) is free", () => {
    expect(R.requirement(cs("8H", "8D"), opts({ eightMode: "invisible" }))).toEqual({ kind: "free" });
  });
  it("reverse-mode 8 (default) is an ordinary climbing card", () => {
    expect(R.requirement(cs("8H"), opts())).toEqual({ kind: "min", value: 8 });
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
  it("invisible 8 always plays, skip/reverse 8 must climb", () => {
    const req = { kind: "min", value: 12 };
    expect(R.canPlayRank("8", req, opts({ eightMode: "invisible" }))).toBe(true);
    expect(R.canPlayRank("8", req, opts({ eightMode: "skip" }))).toBe(false);
    expect(R.canPlayRank("8", req, opts({ eightMode: "reverse" }))).toBe(false);
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

describe("power-card toggles", () => {
  it("a disabled 2 is just the lowest climbing card", () => {
    const o = opts({ twoPower: false });
    expect(R.requirement(cs("KS", "2H"), o)).toEqual({ kind: "min", value: 2 });
    expect(R.canPlayRank("2", { kind: "min", value: 9 }, o)).toBe(false);
    expect(R.isAlwaysPlayable("2", o)).toBe(false);
  });
  it("a disabled 10 no longer burns and must climb", () => {
    const o = opts({ tenPower: false });
    expect(R.burnsPile(cs("10S"), cs("4S", "10S"), o)).toBe(false);
    expect(R.canPlayRank("10", { kind: "min", value: 12 }, o)).toBe(false);
  });
});

describe("jokers", () => {
  it("a joker is always playable when jokers are enabled", () => {
    expect(R.isAlwaysPlayable("JK", opts({ jokers: true }))).toBe(true);
    expect(R.isAlwaysPlayable("JK", opts({ jokers: false }))).toBe(false);
  });
  it("only a 3 counts as a joker defence", () => {
    expect(R.isJokerDefence("3")).toBe(true);
    expect(R.isJokerDefence("4")).toBe(false);
    expect(R.isJoker("JK")).toBe(true);
  });
});

describe("playableRanks / hasLegalPlay", () => {
  it("reports the distinct legal ranks in a zone", () => {
    const hand = cs("4S", "9H", "10C", "2D");
    // A single invisible 8 leaves the pile open, so everything is legal.
    const ranks = R.playableRanks(hand, cs("8S"), opts({ eightMode: "invisible" })).sort();
    expect(ranks).toEqual(["10", "2", "4", "9"].sort());
  });
  it("hasLegalPlay false when nothing beats a high pile", () => {
    expect(R.hasLegalPlay(cs("4S", "5H"), cs("KS"), opts())).toBe(false);
    expect(R.hasLegalPlay(cs("4S", "2H"), cs("KS"), opts())).toBe(true);
  });
});

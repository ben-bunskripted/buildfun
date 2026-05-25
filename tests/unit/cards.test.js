import { describe, it, expect } from "vitest";
import {
  RANKS, SUITS, buildDeck, isWildcard, compareForSort, CARD_POINTS, RANK_VALUE,
} from "../../projects/benny-card-game/js/cards.js";
import { card } from "../helpers.js";

describe("buildDeck", () => {
  it("builds a 52-card deck with unique ids", () => {
    const deck = buildDeck();
    expect(deck).toHaveLength(52);
    const ids = new Set(deck.map(c => c.id));
    expect(ids.size).toBe(52);
  });

  it("covers every rank/suit exactly once with id = rank+suit", () => {
    const deck = buildDeck();
    for (const r of RANKS) {
      for (const s of SUITS) {
        const matches = deck.filter(c => c.rank === r && c.suit === s);
        expect(matches).toHaveLength(1);
        expect(matches[0].id).toBe(`${r}${s}`);
      }
    }
  });

  it("returns a fresh array each call (no shared mutation)", () => {
    const a = buildDeck();
    a.pop();
    expect(buildDeck()).toHaveLength(52);
  });
});

describe("isWildcard", () => {
  it("matches purely on rank", () => {
    expect(isWildcard(card("7H"), "7")).toBe(true);
    expect(isWildcard(card("7S"), "7")).toBe(true);
    expect(isWildcard(card("8H"), "7")).toBe(false);
  });
});

describe("compareForSort", () => {
  it("orders by descending rank value", () => {
    const hand = [card("2S"), card("AS"), card("9S")];
    hand.sort((a, b) => compareForSort(a, b, null));
    expect(hand.map(c => c.rank)).toEqual(["A", "9", "2"]);
  });

  it("breaks rank ties by suit order S<H<D<C", () => {
    const hand = [card("5C"), card("5S"), card("5D"), card("5H")];
    hand.sort((a, b) => compareForSort(a, b, null));
    expect(hand.map(c => c.suit)).toEqual(["S", "H", "D", "C"]);
  });

  it("floats wildcards to the front when a wild rank is given", () => {
    const hand = [card("AS"), card("7H"), card("KS")];
    hand.sort((a, b) => compareForSort(a, b, "7"));
    expect(hand[0].id).toBe("7H");
  });
});

describe("point tables", () => {
  it("score equals face value and matches RANK_VALUE", () => {
    expect(CARD_POINTS.A).toBe(14);
    expect(CARD_POINTS.K).toBe(13);
    expect(CARD_POINTS["10"]).toBe(10);
    expect(CARD_POINTS["2"]).toBe(2);
    for (const r of RANKS) expect(CARD_POINTS[r]).toBe(RANK_VALUE[r]);
  });
});

import { describe, it, expect } from "vitest";
import {
  validateNewSet, validateAddition, validateSwap, annotate,
} from "../../projects/benny-card-game/js/rules.js";
import { cards, card, numberSet, runSet, natSlot, wildSlot } from "../helpers.js";

describe("annotate", () => {
  it("flags wildness by rank", () => {
    expect(annotate(card("KH"), "K").isWild).toBe(true);
    expect(annotate(card("KH"), "7").isWild).toBe(false);
  });
});

describe("validateNewSet — guards", () => {
  it("rejects fewer than 3 cards", () => {
    expect(validateNewSet(cards("5S", "5H"), "K").ok).toBe(false);
  });
  it("rejects an all-wild group (no natural anchor)", () => {
    const v = validateNewSet(cards("KS", "KH", "KD"), "K");
    expect(v.ok).toBe(false);
  });
});

describe("validateNewSet — number sets", () => {
  it("accepts three of a kind", () => {
    const v = validateNewSet(cards("5S", "5H", "5D"), "K");
    expect(v.ok).toBe(true);
    expect(v.type).toBe("number");
    expect(v.rank).toBe("5");
    expect(v.cards).toHaveLength(3);
  });
  it("accepts a wild padding a pair into a set", () => {
    const v = validateNewSet(cards("5S", "5H", "KD"), "K");
    expect(v.ok).toBe(true);
    expect(v.type).toBe("number");
    const wild = v.cards.find(c => c.isWild);
    expect(wild.representsRank).toBe("5");
  });
  it("allows a wild to pad beyond four naturals", () => {
    const v = validateNewSet(cards("5S", "5H", "5D", "5C", "KH"), "K");
    expect(v.ok).toBe(true);
    expect(v.type).toBe("number");
    expect(v.cards).toHaveLength(5);
  });
  it("still rejects a duplicate natural suit", () => {
    const v = validateNewSet(cards("5S", "5H", "5S"), "K");
    expect(v.ok).toBe(false);
  });
});

describe("validateNewSet — runs", () => {
  it("accepts a same-suit consecutive run", () => {
    const v = validateNewSet(cards("6S", "7S", "8S"), "K");
    expect(v.ok).toBe(true);
    expect(v.type).toBe("run");
    const arr = v.arrangements[0];
    expect(arr.suit).toBe("S");
    expect(arr.baseValue).toBe(6);
    expect(arr.length).toBe(3);
  });
  it("treats the Ace as low (A-2-3)", () => {
    const v = validateNewSet(cards("AS", "2S", "3S"), "K");
    expect(v.ok).toBe(true);
    expect(v.arrangements.some(a => a.baseValue === 1)).toBe(true);
  });
  it("treats the Ace as high (Q-K-A)", () => {
    const v = validateNewSet(cards("QS", "KS", "AS"), "7");
    expect(v.ok).toBe(true);
    expect(v.arrangements.some(a => a.baseValue === 12 && a.length === 3)).toBe(true);
  });
  it("rejects a wrap-around run (K-A-2)", () => {
    expect(validateNewSet(cards("KS", "AS", "2S"), "7").ok).toBe(false);
  });
  it("rejects mixed suits with mixed ranks", () => {
    expect(validateNewSet(cards("6S", "7H", "8D"), "K").ok).toBe(false);
  });
});

describe("validateAddition — number sets", () => {
  const set = () => numberSet("5", [natSlot("5S"), natSlot("5H"), natSlot("5D")]);
  it("accepts a matching new suit", () => {
    const v = validateAddition(set(), cards("5C"), "K");
    expect(v.ok).toBe(true);
    expect(v.added).toHaveLength(1);
  });
  it("accepts a wild", () => {
    expect(validateAddition(set(), cards("KC"), "K").ok).toBe(true);
  });
  it("rejects a duplicate suit", () => {
    expect(validateAddition(set(), cards("5S"), "K").ok).toBe(false);
  });
  it("rejects a wrong rank", () => {
    expect(validateAddition(set(), cards("6C"), "K").ok).toBe(false);
  });
  it("allows a wild onto a full four-of-a-kind", () => {
    const full = numberSet("5", [natSlot("5S"), natSlot("5H"), natSlot("5D"), natSlot("5C")]);
    expect(validateAddition(full, cards("KH"), "K").ok).toBe(true);
  });
});

describe("validateAddition — runs", () => {
  const set = () => runSet("S", 6, [natSlot("6S"), natSlot("7S"), natSlot("8S")]);
  it("extends to the right", () => {
    const v = validateAddition(set(), cards("9S"), "K");
    expect(v.ok).toBe(true);
    const arr = v.arrangements[0];
    expect(arr.newBaseValue).toBe(6);
    expect(arr.newLength).toBe(4);
  });
  it("extends to the left", () => {
    const v = validateAddition(set(), cards("5S"), "K");
    expect(v.ok).toBe(true);
    expect(v.arrangements.some(a => a.newBaseValue === 5)).toBe(true);
  });
  it("extends with a wildcard at either end", () => {
    expect(validateAddition(set(), cards("KC"), "K").ok).toBe(true);
  });
  it("rejects a wrong-suit card", () => {
    expect(validateAddition(set(), cards("9H"), "K").ok).toBe(false);
  });
  it("rejects a non-adjacent card", () => {
    expect(validateAddition(set(), cards("JS"), "K").ok).toBe(false);
  });
});

describe("validateSwap", () => {
  it("number set: accepts the represented natural", () => {
    const set = numberSet("5", [natSlot("5S"), natSlot("5H"), wildSlot("KD", "5", "D")]);
    expect(validateSwap(set, 2, card("5D"), "K").ok).toBe(true);
  });
  it("number set: rejects a wrong rank", () => {
    const set = numberSet("5", [natSlot("5S"), natSlot("5H"), wildSlot("KD", "5", "D")]);
    expect(validateSwap(set, 2, card("6D"), "K").ok).toBe(false);
  });
  it("number set: rejects a suit already present", () => {
    const set = numberSet("5", [natSlot("5S"), natSlot("5H"), wildSlot("KD", "5", "D")]);
    expect(validateSwap(set, 2, card("5S"), "K").ok).toBe(false);
  });
  it("run: accepts the exact represented rank+suit", () => {
    const set = runSet("S", 6, [natSlot("6S"), wildSlot("KH", "7", "S"), natSlot("8S")]);
    expect(validateSwap(set, 1, card("7S"), "K").ok).toBe(true);
  });
  it("run: rejects wrong suit / wrong rank", () => {
    const set = runSet("S", 6, [natSlot("6S"), wildSlot("KH", "7", "S"), natSlot("8S")]);
    expect(validateSwap(set, 1, card("7H"), "K").ok).toBe(false);
    expect(validateSwap(set, 1, card("8S"), "K").ok).toBe(false);
  });
  it("rejects targeting a non-wild slot", () => {
    const set = numberSet("5", [natSlot("5S"), natSlot("5H"), wildSlot("KD", "5", "D")]);
    expect(validateSwap(set, 0, card("5C"), "K").ok).toBe(false);
  });
  it("rejects swapping a wildcard in for a wildcard", () => {
    const set = numberSet("5", [natSlot("5S"), natSlot("5H"), wildSlot("KD", "5", "D")]);
    expect(validateSwap(set, 2, card("KH"), "K").ok).toBe(false);
  });
});

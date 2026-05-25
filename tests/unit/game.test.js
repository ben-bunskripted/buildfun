import { describe, it, expect } from "vitest";
import {
  createMatch, startNextRound, beginTurn, currentPlayer, topOfDiscard,
  drawFromDeck, drawFromDiscard, placeNewSet, addToSet, swapWildcard, discard,
  serialize, hydrate, isMatchOver, advanceToNextRound, matchWinnerIndex,
  TOTAL_ROUNDS, WILDCARD_ORDER, STATE_VERSION,
} from "../../projects/benny-card-game/js/game.js";
import { validateNewSet, validateAddition } from "../../projects/benny-card-game/js/rules.js";
import { buildDeck } from "../../projects/benny-card-game/js/cards.js";
import { cards, card, freshMatch, numberSet, runSet, natSlot, wildSlot } from "../helpers.js";

describe("createMatch", () => {
  it("builds players with kinds, difficulties, and the dealer as first to act", () => {
    const s = createMatch(["H", "C"], 1, { mode: "cpu", playerKinds: ["human", "cpu"], difficulties: [undefined, "hard"] });
    expect(s.players).toHaveLength(2);
    expect(s.players[1].kind).toBe("cpu");
    expect(s.players[1].difficulty).toBe("hard");
    expect(s.dealerIndex).toBe(1);
    expect(s.currentPlayerIndex).toBe(1);
    expect(s.phase).toBe("matchStart");
  });
});

describe("startNextRound — dealing", () => {
  it("deals 7 to each non-dealer and 8 to the dealer, sets the wildcard", () => {
    const s = createMatch(["A", "B"], 0);
    startNextRound(s, { deck: buildDeck() });
    expect(s.round).toBe(1);
    expect(s.wildcardRank).toBe(WILDCARD_ORDER[0]);
    expect(s.players[0].hand).toHaveLength(8); // dealer gets the extra card
    expect(s.players[1].hand).toHaveLength(7);
    expect(s.deck).toHaveLength(52 - 15);
    expect(s.dealerOpeningPending).toBe(true);
    expect(s.phase).toBe("passing");
    // No card is dealt twice.
    const dealt = [...s.players[0].hand, ...s.players[1].hand].map(c => c.id);
    expect(new Set(dealt).size).toBe(dealt.length);
  });
});

describe("beginTurn", () => {
  it("lets the opening dealer act immediately (no draw)", () => {
    const s = freshMatch(["A", "B"]);
    s.dealerOpeningPending = true;
    s.currentPlayerIndex = 0;
    s.dealerIndex = 0;
    beginTurn(s);
    expect(s.phase).toBe("canAct");
  });
  it("makes a normal turn start with a mandatory draw", () => {
    const s = freshMatch(["A", "B"]);
    s.dealerOpeningPending = false;
    s.currentPlayerIndex = 1;
    beginTurn(s);
    expect(s.phase).toBe("mustDraw");
  });
});

describe("draws", () => {
  it("drawFromDeck moves the top card to hand and flips to canAct", () => {
    const s = freshMatch(["A", "B"]);
    s.phase = "mustDraw";
    s.currentPlayerIndex = 0;
    s.deck = cards("5H", "6H");
    const r = drawFromDeck(s);
    expect(r.ok).toBe(true);
    expect(r.card.id).toBe("5H");
    expect(currentPlayer(s).hand.map(c => c.id)).toContain("5H");
    expect(s.lastDrawnCardId).toBe("5H");
    expect(s.phase).toBe("canAct");
  });
  it("drawFromDeck reshuffles the discard pile when the deck is empty", () => {
    const s = freshMatch(["A", "B"]);
    s.phase = "mustDraw";
    s.currentPlayerIndex = 0;
    s.deck = [];
    s.discardPile = cards("2C", "3C", "4C"); // top is 4C
    const r = drawFromDeck(s);
    expect(r.ok).toBe(true);
    expect(s.discardPile).toHaveLength(1); // only the kept top remains
    expect(s.discardPile[0].id).toBe("4C");
  });
  it("drawFromDeck refuses when nothing is left to draw", () => {
    const s = freshMatch(["A", "B"]);
    s.phase = "mustDraw";
    s.deck = [];
    s.discardPile = cards("4C");
    expect(drawFromDeck(s).ok).toBe(false);
  });
  it("respects the phase guard", () => {
    const s = freshMatch(["A", "B"]);
    s.phase = "canAct";
    s.deck = cards("5H");
    expect(drawFromDeck(s).ok).toBe(false);
  });
  it("drawFromDiscard takes the top of the discard pile", () => {
    const s = freshMatch(["A", "B"]);
    s.phase = "mustDraw";
    s.currentPlayerIndex = 0;
    s.discardPile = cards("2C", "9D"); // top is 9D
    const r = drawFromDiscard(s);
    expect(r.ok).toBe(true);
    expect(r.card.id).toBe("9D");
    expect(topOfDiscard(s).id).toBe("2C");
  });
});

describe("placeNewSet", () => {
  function withHand(ids) {
    const s = freshMatch(["A", "B"], { wildcardRank: "K" });
    s.phase = "canAct";
    s.currentPlayerIndex = 0;
    s.players[0].hand = cards(...ids);
    return s;
  }
  it("places a valid set, removes the cards, and marks the player opened", () => {
    const s = withHand(["5S", "5H", "5D", "9C"]);
    const v = validateNewSet(cards("5S", "5H", "5D"), "K");
    const r = placeNewSet(s, v);
    expect(r.ok).toBe(true);
    expect(s.table).toHaveLength(1);
    expect(s.players[0].hasOpened).toBe(true);
    expect(s.players[0].hand.map(c => c.id)).toEqual(["9C"]);
    expect(s.matchEvents.opens).toHaveLength(1);
    expect(s.matchEvents.setsPlayed).toHaveLength(1);
  });
  it("rejects a second number set of a rank already on the table", () => {
    const s = withHand(["5S", "5H", "5D", "9C"]);
    placeNewSet(s, validateNewSet(cards("5S", "5H", "5D"), "K"));
    s.currentPlayerIndex = 1;
    s.players[1].hand = cards("5C", "KH", "KD", "2C");
    const v = validateNewSet(cards("5C", "KH", "KD"), "K");
    expect(placeNewSet(s, v).ok).toBe(false);
  });
  it("refuses to leave the player with nothing to discard", () => {
    const s = withHand(["5S", "5H", "5D"]); // all 3 would empty the hand
    expect(placeNewSet(s, validateNewSet(cards("5S", "5H", "5D"), "K")).ok).toBe(false);
  });
  it("respects the phase guard", () => {
    const s = withHand(["5S", "5H", "5D", "9C"]);
    s.phase = "mustDraw";
    expect(placeNewSet(s, validateNewSet(cards("5S", "5H", "5D"), "K")).ok).toBe(false);
  });
});

describe("addToSet", () => {
  it("requires the player to have opened", () => {
    const s = freshMatch(["A", "B"], { wildcardRank: "K" });
    s.phase = "canAct";
    s.currentPlayerIndex = 0;
    s.players[0].hasOpened = false;
    s.players[0].hand = cards("5C", "9D");
    s.table = [numberSet("5", [natSlot("5S"), natSlot("5H"), natSlot("5D")])];
    const v = validateAddition(s.table[0], cards("5C"), "K");
    expect(addToSet(s, "set1", v).ok).toBe(false);
  });
  it("adds to a number set after opening", () => {
    const s = freshMatch(["A", "B"], { wildcardRank: "K" });
    s.phase = "canAct";
    s.currentPlayerIndex = 0;
    s.players[0].hasOpened = true;
    s.players[0].hand = cards("5C", "9D");
    s.table = [numberSet("5", [natSlot("5S"), natSlot("5H"), natSlot("5D")])];
    const v = validateAddition(s.table[0], cards("5C"), "K");
    const r = addToSet(s, "set1", v);
    expect(r.ok).toBe(true);
    expect(s.table[0].cards).toHaveLength(4);
    expect(s.players[0].hand.map(c => c.id)).toEqual(["9D"]);
  });
  it("extends a run and keeps it ordered by value", () => {
    const s = freshMatch(["A", "B"], { wildcardRank: "K" });
    s.phase = "canAct";
    s.currentPlayerIndex = 0;
    s.players[0].hasOpened = true;
    s.players[0].hand = cards("5S", "9D");
    s.table = [runSet("S", 6, [natSlot("6S"), natSlot("7S"), natSlot("8S")])];
    const v = validateAddition(s.table[0], cards("5S"), "K");
    const r = addToSet(s, "run1", v.arrangements[0]);
    expect(r.ok).toBe(true);
    expect(s.table[0].baseValue).toBe(5);
    expect(s.table[0].cards.map(c => c.card.id)).toEqual(["5S", "6S", "7S", "8S"]);
  });
});

describe("swapWildcard", () => {
  it("hands the wildcard back and places the natural in the set", () => {
    const s = freshMatch(["A", "B"], { wildcardRank: "K" });
    s.phase = "canAct";
    s.currentPlayerIndex = 0;
    s.players[0].hasOpened = true;
    s.players[0].hand = cards("7S", "9D");
    s.table = [runSet("S", 6, [natSlot("6S"), wildSlot("KH", "7", "S"), natSlot("8S")])];
    const r = swapWildcard(s, "run1", 1, "7S");
    expect(r.ok).toBe(true);
    expect(s.table[0].cards[1].card.id).toBe("7S");
    expect(s.table[0].cards[1].isWild).toBe(false);
    expect(s.players[0].hand.map(c => c.id)).toContain("KH"); // wild returned
    expect(s.players[0].hand.map(c => c.id)).not.toContain("7S");
  });
});

describe("discard + round end", () => {
  it("passes the turn when the hand is not empty", () => {
    const s = freshMatch(["A", "B"], { wildcardRank: "K" });
    s.phase = "canAct";
    s.currentPlayerIndex = 0;
    s.players[0].hand = cards("5S", "9D");
    const r = discard(s, "9D");
    expect(r.ok).toBe(true);
    expect(r.wonRound).toBe(false);
    expect(topOfDiscard(s).id).toBe("9D");
    expect(s.currentPlayerIndex).toBe(1);
    expect(s.phase).toBe("passing");
  });
  it("wins the round and scores hands (wild=15, winner=0)", () => {
    const s = freshMatch(["A", "B"], { wildcardRank: "K" });
    s.phase = "canAct";
    s.currentPlayerIndex = 0;
    s.players[0].hand = cards("9D"); // last card
    s.players[1].hand = cards("5H", "KH"); // 5 + wild(15)
    const r = discard(s, "9D");
    expect(r.wonRound).toBe(true);
    expect(s.roundWinner).toBe(0);
    expect(s.perRoundScores).toEqual([0, 20]);
    expect(s.players[1].score).toBe(20);
    expect(s.phase).toBe("roundOver");
  });
});

describe("serialize / hydrate", () => {
  it("round-trips state through JSON", () => {
    const s = freshMatch(["A", "B"]);
    s.players[0].hand = cards("5S", "5H");
    const back = hydrate(serialize(s));
    expect(back.players[0].hand.map(c => c.id)).toEqual(["5S", "5H"]);
  });
  it("rejects a snapshot with the wrong version", () => {
    const s = serialize(freshMatch(["A", "B"]));
    s.version = STATE_VERSION + 99;
    expect(hydrate(s)).toBeNull();
  });
});

describe("match progression", () => {
  it("advanceToNextRound rotates the dealer clockwise", () => {
    const s = createMatch(["A", "B", "C"], 0);
    startNextRound(s, { deck: buildDeck() });
    advanceToNextRound(s);
    expect(s.dealerIndex).toBe(1);
    expect(s.round).toBe(2);
  });
  it("isMatchOver only after the final round resolves", () => {
    const s = createMatch(["A", "B"], 0);
    s.round = TOTAL_ROUNDS;
    s.phase = "passing";
    expect(isMatchOver(s)).toBe(false);
    s.phase = "roundOver";
    expect(isMatchOver(s)).toBe(true);
  });
  it("matchWinnerIndex picks the lowest total", () => {
    const s = createMatch(["A", "B", "C"], 0);
    s.players[0].score = 30;
    s.players[1].score = 12;
    s.players[2].score = 45;
    expect(matchWinnerIndex(s)).toBe(1);
  });
});

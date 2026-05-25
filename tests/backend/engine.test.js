import { describe, it, expect } from "vitest";
import { applyAction, redactStateForSeat } from "../../netlify/functions/_engine.mjs";
import { createMatch, startNextRound, beginTurn } from "../../projects/benny-card-game/js/game.js";
import { buildDeck } from "../../projects/benny-card-game/js/cards.js";
import { validateNewSet } from "../../projects/benny-card-game/js/rules.js";
import { cards } from "../helpers.js";

function dealtMatch() {
  const s = createMatch(["P0", "P1"], 0);
  startNextRound(s, { deck: buildDeck() });
  return s;
}

describe("applyAction — turn + auth enforcement", () => {
  it("rejects actions from a seat that isn't the current player", () => {
    const s = dealtMatch();
    const r = applyAction(s, 1, { type: "drawDeck" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/your turn/i);
  });
  it("rejects a malformed action", () => {
    const s = dealtMatch();
    expect(applyAction(s, 0, null).ok).toBe(false);
    expect(applyAction(s, 0, { type: "frobnicate" }).ok).toBe(false);
  });
  it("auto-advances a fresh 'passing' turn so the actor needn't begin it", () => {
    const s = dealtMatch();
    // Dealer's opening turn: passing -> canAct, so a play is legal immediately.
    s.players[0].hand = cards("5S", "5H", "5D", "9C", "2H", "8D", "JC", "QS");
    const v = validateNewSet(cards("5S", "5H", "5D"), s.wildcardRank);
    const r = applyAction(s, 0, { type: "play", arrangement: v });
    expect(r.ok).toBe(true);
    expect(r.recordedAction.type).toBe("play");
  });
});

describe("applyAction — drawing", () => {
  it("returns the drawn card privately on drawDeck (not on the recorded action)", () => {
    const s = dealtMatch();
    s.dealerOpeningPending = false; // make seat 0 a normal (drawing) turn
    s.phase = "passing";
    const r = applyAction(s, 0, { type: "drawDeck" });
    expect(r.ok).toBe(true);
    expect(r.drawnCard).toBeTruthy();
    expect(r.recordedAction).toEqual({ type: "drawDeck" }); // no card leaked
  });
  it("records the public card on drawDiscard", () => {
    const s = dealtMatch();
    s.dealerOpeningPending = false;
    s.phase = "passing";
    s.discardPile = cards("9D");
    beginTurn(s);
    const r = applyAction(s, 0, { type: "drawDiscard" });
    expect(r.ok).toBe(true);
    expect(r.recordedAction.card.id).toBe("9D");
  });
});

describe("applyAction — validates against the real hand, not client claims", () => {
  it("rejects a play whose cards aren't in the actor's hand", () => {
    const s = dealtMatch();
    s.players[0].hand = cards("2H", "3D", "8C", "JC", "QS", "KH", "4D", "6S");
    // Claim a 5-set the player doesn't hold.
    const fakeArrangement = {
      type: "number", rank: "5",
      cards: cards("5S", "5H", "5D").map(c => ({ card: c, isWild: false, representsRank: "5", representsSuit: c.suit })),
    };
    const r = applyAction(s, 0, { type: "play", arrangement: fakeArrangement });
    expect(r.ok).toBe(false);
  });
  it("rejects duplicate card ids inside one arrangement", () => {
    const s = dealtMatch();
    s.players[0].hand = cards("5S", "5H", "5D", "9C", "2H", "8D", "JC", "QS");
    const dup = {
      type: "number", rank: "5",
      cards: cards("5S", "5S", "5H").map(c => ({ card: c, isWild: false, representsRank: "5", representsSuit: c.suit })),
    };
    expect(applyAction(s, 0, { type: "play", arrangement: dup }).ok).toBe(false);
  });
});

describe("applyAction — discard reports the win", () => {
  it("flags wonRound when the discard empties the hand", () => {
    const s = dealtMatch();
    s.dealerOpeningPending = false;
    s.phase = "canAct";
    s.players[0].hand = cards("9D");
    const r = applyAction(s, 0, { type: "discard", cardId: "9D" });
    expect(r.ok).toBe(true);
    expect(r.wonRound).toBe(true);
    expect(r.recordedAction.card.id).toBe("9D");
  });
});

describe("redactStateForSeat", () => {
  it("hides every other hand + the deck but keeps the caller's own hand", () => {
    const s = dealtMatch();
    const view = redactStateForSeat(s, 0);
    // Caller sees their real cards.
    expect(view.players[0].hand.every(c => !c.hidden)).toBe(true);
    expect(view.players[0].hand.map(c => c.id)).toEqual(s.players[0].hand.map(c => c.id));
    // Opponents are opaque but length-preserving.
    expect(view.players[1].hand).toHaveLength(s.players[1].hand.length);
    expect(view.players[1].hand.every(c => c.hidden)).toBe(true);
    // Deck is fully hidden.
    expect(view.deck.every(c => c.hidden)).toBe(true);
    expect(view.deck).toHaveLength(s.deck.length);
  });
  it("does not mutate the canonical state", () => {
    const s = dealtMatch();
    const snap = JSON.stringify(s);
    redactStateForSeat(s, 1);
    expect(JSON.stringify(s)).toBe(snap);
  });
});

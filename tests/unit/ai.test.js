import { describe, it, expect } from "vitest";
import { planTurn } from "../../projects/benny-card-game/js/ai.js";
import {
  createMatch, startNextRound, beginTurn,
  drawFromDeck, drawFromDiscard, placeNewSet, addToSet, swapWildcard, discard,
  serialize, isNoWayOut, finalizeNoWayOut,
} from "../../projects/benny-card-game/js/game.js";
import { buildDeck } from "../../projects/benny-card-game/js/cards.js";
import { freshMatch, numberSet, runSet, natSlot, wildSlot, cards } from "../helpers.js";

// Apply one CPU action through the real engine; return the engine result.
function applyAction(state, a) {
  switch (a.type) {
    case "drawDeck": return drawFromDeck(state);
    case "drawDiscard": return drawFromDiscard(state);
    case "play": return placeNewSet(state, a.arrangement);
    case "add": return addToSet(state, a.setId, a.arrangement);
    case "swap": return swapWildcard(state, a.setId, a.positionIndex, a.naturalCardId);
    case "discard": return discard(state, a.cardId);
    default: throw new Error("unknown action " + a.type);
  }
}

// Every card in play, wherever it lives, should be one of the 52 uniques.
function allCardIds(state) {
  const ids = [];
  for (const p of state.players) for (const c of p.hand) ids.push(c.id);
  for (const s of state.table) for (const c of s.cards) ids.push(c.card.id);
  for (const c of state.deck) ids.push(c.id);
  for (const c of state.discardPile) ids.push(c.id);
  return ids;
}

function makeCpuMatch(n, difficulty) {
  const names = Array.from({ length: n }, (_, i) => "CPU" + i);
  const s = createMatch(names, 0, {
    mode: "cpu",
    playerKinds: names.map(() => "cpu"),
    difficulties: names.map(() => difficulty),
  });
  startNextRound(s, { deck: buildDeck() });
  return s;
}

for (const difficulty of ["easy", "medium", "hard"]) {
  describe(`planTurn — ${difficulty}`, () => {
    it("produces only legal actions and never mutates state during planning", () => {
      const s = makeCpuMatch(4, difficulty);
      let opens = 0;
      let ended = false;

      for (let turn = 0; turn < 120 && !ended; turn++) {
        beginTurn(s);

        // Planning must be pure: state identical before and after planTurn.
        const before = JSON.stringify(serialize(s));
        const plan = planTurn(s, difficulty);
        expect(JSON.stringify(serialize(s))).toBe(before);

        expect(Array.isArray(plan)).toBe(true);
        expect(plan.length).toBeGreaterThan(0);

        for (const a of plan) {
          const r = applyAction(s, a);
          expect(r.ok, `action ${a.type} failed: ${r.reason}`).toBe(true);
          if (a.type === "play") opens++;
          if (r.wonRound) ended = true;
        }

        // Card conservation holds after every turn.
        const ids = allCardIds(s);
        expect(ids).toHaveLength(52);
        expect(new Set(ids).size).toBe(52);

        // The plan must end the turn: either the round ended, or the table
        // gained a discard and control passed on.
        if (!ended) {
          expect(s.phase).toBe("passing");
          if (isNoWayOut(s)) { finalizeNoWayOut(s); ended = true; }
        }
      }

      // Medium/hard CPUs should actually build melds, not just draw-and-dump.
      if (difficulty !== "easy") expect(opens).toBeGreaterThan(0);
    });
  });
}

// A non-dealer-opening turn fixture: current player (0) has opened, it's their
// turn, the deck has one inert card to draw, and matchEvents is already present
// (freshMatch populates it). Wildcard rank is K so plain spot cards aren't wild.
function turnFixture({ hand, table, deckTop = "7C", discardTop = "QH" }) {
  const s = freshMatch(["Me", "Opp"], { wildcardRank: "K" });
  s.dealerOpeningPending = false;
  s.currentPlayerIndex = 0;
  s.players[0].hasOpened = true;
  s.players[0].hand = cards(...hand);
  s.players[1].hand = cards("2C", "3C", "4C", "5C", "6C", "7H");
  s.table = table;
  s.deck = cards(deckTop);
  s.discardPile = cards(discardTop);
  return s;
}

describe("planTurn — hard: pick up a discard that extends a table meld", () => {
  it("picks up the top card when it can be added to an existing run", () => {
    // Run 5-6-7 of spades on the table; 8S sits on the discard. Our hand can't
    // open and shares no rank with 8S, so the ONLY reason to take it is the add.
    const s = turnFixture({
      hand: ["9H", "3D", "2C"],
      table: [runSet("S", 5, [natSlot("5S"), natSlot("6S"), natSlot("7S")], { id: "run1", ownerIndex: 0 })],
      discardTop: "8S",
    });
    const plan = planTurn(s, "hard");
    expect(plan[0].type).toBe("drawDiscard");
    expect(plan.some(a => a.type === "add" && a.arrangement.added.some(c => c.card.id === "8S"))).toBe(true);
  });
});

describe("planTurn — hard: swap a benny out instead of padding a set", () => {
  it("recovers the wildcard rather than adding the natural to the set", () => {
    // Number set 5S-5H-(wild=5). We hold 5D, which could either pad the set to
    // four OR swap the wildcard back. With a roomy hand (so the reclaimed benny
    // can still be cashed as go-out fuel) and no endgame, the swap should win.
    const s = turnFixture({
      hand: ["5D", "9H", "3C", "JD", "2H"],
      table: [numberSet("5", [natSlot("5S"), natSlot("5H"), wildSlot("KC", "5")], { id: "set1", ownerIndex: 0 })],
    });
    const plan = planTurn(s, "hard");
    expect(plan.some(a => a.type === "swap" && a.naturalCardId === "5D")).toBe(true);
    expect(plan.some(a => a.type === "add" && a.arrangement.added.some(c => c.card.id === "5D"))).toBe(false);
  });

  it("takes back multiple bennies in one turn", () => {
    // Two number sets, each holding a wildcard; we hold a natural that swaps
    // each one. With a roomy hand both should come back in a single turn, not
    // just one. (The reclaim only fires when there's breathing room to reuse
    // the bennies — so the hand is padded with inert cards.)
    const s = turnFixture({
      hand: ["5D", "8D", "9H", "JC", "2H"],
      table: [
        numberSet("5", [natSlot("5S"), natSlot("5H"), wildSlot("KC", "5")], { id: "set1", ownerIndex: 0 }),
        numberSet("8", [natSlot("8S"), natSlot("8H"), wildSlot("KD", "8")], { id: "set2", ownerIndex: 0 }),
      ],
    });
    const plan = planTurn(s, "hard");
    const swaps = plan.filter(a => a.type === "swap");
    expect(swaps.map(a => a.naturalCardId).sort()).toEqual(["5D", "8D"]);
  });

  it("still pads the set (sheds a card) when an opponent is about to go out", () => {
    const s = turnFixture({
      hand: ["5D", "9H", "3C"],
      table: [numberSet("5", [natSlot("5S"), natSlot("5H"), wildSlot("KC", "5")], { id: "set1", ownerIndex: 0 })],
    });
    s.players[1].hand = cards("2C"); // one card left → endgame threat
    s.players[1].hasOpened = true;
    const plan = planTurn(s, "hard");
    expect(plan.some(a => a.type === "add" && a.arrangement.added.some(c => c.card.id === "5D"))).toBe(true);
  });

  it("swaps a trapped benny free, lays it onto a set, and goes out", () => {
    // The flip side of the trap: here reclaiming the benny WINS. A benny is
    // trapped mid-run (8-9-W=10-J♥), so our 10♥ can only come into play via a
    // swap. Once freed, the benny pads the complete 5-set and we discard to go
    // out. The CPU must find this swap→meld→out line rather than holding the 10.
    const s = turnFixture({
      hand: ["10H"],
      table: [
        runSet("H", 8, [natSlot("8H"), natSlot("9H"), wildSlot("KC", "10", "H"), natSlot("JH")], { id: "run1", ownerIndex: 0 }),
        numberSet("5", [natSlot("5S"), natSlot("5H"), natSlot("5D"), natSlot("5C")], { id: "set1", ownerIndex: 0 }),
      ],
      deckTop: "2C",
      discardTop: "QD",
    });
    const plan = planTurn(s, "hard");
    expect(plan.some(a => a.type === "swap" && a.naturalCardId === "10H")).toBe(true);
    expect(plan.some(a => a.type === "add" && a.arrangement.added.some(c => c.card.id === "KC"))).toBe(true);
    // Applied through the real engine, the line empties the hand and wins.
    beginTurn(s);
    let won = false;
    for (const a of plan) {
      const r = applyAction(s, a);
      expect(r.ok, `action ${a.type} failed: ${r.reason}`).toBe(true);
      if (a.type === "discard" && r.wonRound) won = true;
    }
    expect(won).toBe(true);
    expect(s.players[0].hand.length).toBe(0);
  });

  it("won't swap its last natural into a benny it would then be caught holding", () => {
    // Regression: a hard CPU down to a short hand whose only natural (5D) matches
    // a buried wild USED to reclaim the benny unconditionally, then get marooned
    // holding 15 points when the round ended before it could cash it. With a
    // short hand there's no room to reuse the benny, so it must NOT swap — it
    // sheds the low natural and is caught with a cheap card, not the benny.
    const s = turnFixture({
      hand: ["5D", "9H"],
      table: [numberSet("5", [natSlot("5S"), natSlot("5H"), wildSlot("KC", "5")], { id: "set1", ownerIndex: 0 })],
      deckTop: "2H", // inert draw → hand peaks at 3, still below the reclaim floor
    });
    const plan = planTurn(s, "hard");
    expect(plan.some(a => a.type === "swap")).toBe(false);
    // And it never ends the turn holding the benny: KC is on the table the whole
    // time, so the only way to hold it is to have swapped it in.
    beginTurn(s);
    for (const a of plan) expect(applyAction(s, a).ok).toBe(true);
    expect(s.players[0].hand.some(c => c.id === "KC")).toBe(false);
  });
});

describe("planTurn — wildcard discipline when adding to a set", () => {
  for (const difficulty of ["medium", "hard"]) {
    it(`${difficulty}: sheds a natural onto a run but never buries a benny`, () => {
      // Run 5-6-7♠ on the table. We hold a benny (KC), an 8♠ that extends the
      // run, and a spare 9♥. The greedy "add highest value" rule would dump the
      // benny (worth 15) onto the run; discipline must add the 8♠ instead and
      // keep the benny in hand as go-out fuel. No opponent pressure.
      const s = turnFixture({
        hand: ["KC", "8S", "9H"],
        table: [runSet("S", 5, [natSlot("5S"), natSlot("6S"), natSlot("7S")], { id: "run1", ownerIndex: 0 })],
      });
      const plan = planTurn(s, difficulty);
      // The benny is never played or added to a set.
      expect(plan.some(a => a.type === "add" && a.arrangement.added.some(c => c.card.id === "KC"))).toBe(false);
      expect(plan.some(a => a.type === "play" && a.arrangement.cards.some(c => c.card.id === "KC"))).toBe(false);
      // The natural extension still happens.
      expect(plan.some(a => a.type === "add" && a.arrangement.added.some(c => c.card.id === "8S"))).toBe(true);
    });
  }

  it("still spends a benny to shed when an opponent is about to go out", () => {
    // Same shape, but the opponent is on a single card: now minimising what we
    // could be caught holding beats hoarding the wild, so dumping it is allowed.
    const s = turnFixture({
      hand: ["KC", "9H", "3D"],
      table: [runSet("S", 5, [natSlot("5S"), natSlot("6S"), natSlot("7S")], { id: "run1", ownerIndex: 0 })],
    });
    s.players[1].hand = cards("2C");
    s.players[1].hasOpened = true;
    const plan = planTurn(s, "hard");
    expect(plan.some(a => a.type === "add" && a.arrangement.added.some(c => c.card.id === "KC"))).toBe(true);
  });
});

describe("planTurn — discard: don't hoard a high card when our own hand is short", () => {
  it("sheds a high swap-key it can't cash in yet rather than getting caught with it", () => {
    // Opponent run 8-9-(wild=10)-J♥; we hold 10♥ (which could later swap that
    // benny out) plus a junk 3♣ — but we haven't opened, so we can't swap this
    // turn, and we're down to two cards. Holding the 10 just risks being caught
    // with it; the CPU should shed the high card. (10♥ sits inside the run so it
    // can't be gifted as an add, isolating the hoard decision.)
    const s = turnFixture({
      hand: ["10H", "3C"],
      table: [runSet("H", 8, [natSlot("8H"), natSlot("9H"), wildSlot("KC", "10", "H"), natSlot("JH")], { id: "run1", ownerIndex: 1 })],
    });
    s.players[0].hasOpened = false; // can't actually swap → no reason to cling
    const plan = planTurn(s, "hard");
    const disc = plan.find(a => a.type === "discard");
    expect(disc.cardId).toBe("10H");
  });

  it("still hoards the swap-key when our hand has room to use it", () => {
    // Same swap-key (10♥ matches the buried wild), but now a roomy hand: keeping
    // the 10 to reclaim the benny later is worth more than its raw rank, so the
    // CPU sheds a low card instead.
    const s = turnFixture({
      hand: ["10H", "2C", "3C", "4D", "9S", "5S"],
      table: [runSet("H", 8, [natSlot("8H"), natSlot("9H"), wildSlot("KC", "10", "H"), natSlot("JH")], { id: "run1", ownerIndex: 1 })],
    });
    s.players[0].hasOpened = false;
    const plan = planTurn(s, "hard");
    const disc = plan.find(a => a.type === "discard");
    expect(disc.cardId).not.toBe("10H");
  });
});

describe("planTurn — hard: going out beats wildcard recovery", () => {
  it("picks up and adds the discard top to win rather than swapping a benny", () => {
    // We're down to a single card (2D). The discard top (8S) both extends the
    // run 5-6-7♠ AND could swap the wildcard out of the 8-set. The greedy
    // wildcard-recovery heuristic would swap and leave us holding a card — but
    // picking up 8S, adding it, then discarding 2D empties our hand and WINS.
    // Going out must dominate every positional heuristic.
    const s = turnFixture({
      hand: ["2D"],
      table: [
        runSet("S", 5, [natSlot("5S"), natSlot("6S"), natSlot("7S")], { id: "run1", ownerIndex: 0 }),
        numberSet("8", [natSlot("8H"), natSlot("8C"), wildSlot("KD", "8")], { id: "set1", ownerIndex: 0 }),
      ],
      discardTop: "8S",
    });
    const plan = planTurn(s, "hard");
    expect(plan[0].type).toBe("drawDiscard");
    expect(plan.some(a => a.type === "swap")).toBe(false);

    // The whole plan, applied through the real engine, must empty the hand.
    beginTurn(s);
    let won = false;
    for (const a of plan) {
      const r = applyAction(s, a);
      expect(r.ok).toBe(true);
      if (a.type === "discard" && r.wonRound) won = true;
    }
    expect(won).toBe(true);
    expect(s.players[0].hand.length).toBe(0);
  });

  it("goes out via a deck draw when that is the only winning line", () => {
    // 8S is on top of the deck (drawn), completing 5-6-7♠ → discard 2D to win.
    const s = turnFixture({
      hand: ["2D"],
      table: [runSet("S", 5, [natSlot("5S"), natSlot("6S"), natSlot("7S")], { id: "run1", ownerIndex: 0 })],
      deckTop: "8S",
      discardTop: "QH",
    });
    const plan = planTurn(s, "hard");
    beginTurn(s);
    let won = false;
    for (const a of plan) {
      const r = applyAction(s, a);
      expect(r.ok).toBe(true);
      if (a.type === "discard" && r.wonRound) won = true;
    }
    expect(won).toBe(true);
  });
});

describe("planTurn — hard: wildcard discipline when opening", () => {
  function holdFixture(hand, oppHand) {
    const s = freshMatch(["Me", "Opp"], { wildcardRank: "K" });
    s.dealerOpeningPending = false;
    s.currentPlayerIndex = 0;
    s.players[0].hasOpened = false;
    s.players[0].hand = cards(...hand);
    s.players[1].hand = cards(...oppHand);
    s.table = [];
    s.deck = cards("9D");          // inert draw — won't complete a natural set
    s.discardPile = cards("7C");   // inert top
    return s;
  }

  it("#1: won't open a majority-wildcard set — holds the bennies instead", () => {
    // 2 naturals + 2 bennies: every legal new set here is majority-wild
    // (1 natural + 2 wilds). With no opponent pressure, hold them.
    const s = holdFixture(["5H", "2C", "KC", "KD"], ["2S", "3S", "4S", "5S", "6S", "7S"]);
    const plan = planTurn(s, "hard");
    expect(plan.some(a => a.type === "play")).toBe(false);
  });

  it("#2: holds a low-value wild run when no opponent is threatening", () => {
    // 2♠3♠ + a benny is a legal (non-wild-heavy) run, but frees only 5 natural
    // points — not worth stranding a 15-point wildcard with the round wide open.
    const s = holdFixture(["2S", "3S", "KC", "9D"], ["2H", "3H", "4H", "5H", "6H", "7H"]);
    const plan = planTurn(s, "hard");
    expect(plan.some(a => a.type === "play")).toBe(false);
  });

  it("#2: spends the wild to shed once an opponent is about to go out", () => {
    const s = holdFixture(["2S", "3S", "KC", "9D"], ["2H"]); // opponent on 1 card
    s.players[1].hasOpened = true;
    const plan = planTurn(s, "hard");
    expect(plan.some(a => a.type === "play")).toBe(true);
  });
});

describe("planTurn — hard: shape-aware opening", () => {
  it("#3: opens the run that keeps a pair, not the set that breaks it", () => {
    // 5♠6♠7♠ (run) and 6♠6♥6♦ (set) are both available and equal value (18),
    // but share 6♠ so only one can be laid. The run leaves the 6♥6♦ pair intact;
    // the set leaves a weak 5♠/7♠ gap. Shape awareness should prefer the run.
    const s = freshMatch(["Me", "Opp"], { wildcardRank: "K" });
    s.dealerOpeningPending = false;
    s.currentPlayerIndex = 0;
    s.players[0].hasOpened = false;
    s.players[0].hand = cards("5S", "6S", "7S", "6H", "6D");
    s.players[1].hand = cards("2H", "3H", "4H", "8H", "9H", "10H");
    s.table = [];
    s.deck = cards("QD");
    s.discardPile = cards("2C");
    const plan = planTurn(s, "hard");
    const play = plan.find(a => a.type === "play");
    expect(play).toBeTruthy();
    expect(play.arrangement.type).toBe("run");
    expect(play.arrangement.suit).toBe("S");
  });
});

describe("planTurn — discard defence: opened opponents can use ANY table set", () => {
  it("won't gift a card that fits the CPU's OWN meld once an opponent has opened", () => {
    // The engine has no ownership check on addToSet: an opened opponent can
    // bolt our discard onto OUR run. We hold 8♠ (extends our own 5-6-7♠) but
    // haven't opened ourselves, so we can't use it — the greedy "shed highest
    // value" rule would discard it. With an opened opponent at the table,
    // that's a gift; shed the next-best card instead.
    const s = turnFixture({
      hand: ["8S", "5H", "2C"],
      table: [
        runSet("S", 5, [natSlot("5S"), natSlot("6S"), natSlot("7S")], { id: "run1", ownerIndex: 0 }),
        numberSet("J", [natSlot("JC"), natSlot("JD"), natSlot("JH")], { id: "set1", ownerIndex: 1 }),
      ],
      deckTop: "3D",
    });
    s.players[0].hasOpened = false; // we can't add the 8♠ ourselves
    s.players[1].hasOpened = true;
    const plan = planTurn(s, "hard");
    const disc = plan.find(a => a.type === "discard");
    expect(disc.cardId).not.toBe("8S");
  });

  it("won't hand an opened opponent the key to a buried wildcard", () => {
    // Short hand, so the self-hoard taper no longer protects the 10♥ — but the
    // opponent has opened, and our 10♥ swaps the benny out of the table run.
    // Discarding it lets them pick it up and reclaim 15-point go-out fuel, so
    // the CPU sheds the 9♣ instead.
    const s = turnFixture({
      hand: ["10H", "9C"],
      table: [runSet("H", 8, [natSlot("8H"), natSlot("9H"), wildSlot("KC", "10", "H"), natSlot("JH")], { id: "run1", ownerIndex: 1 })],
      deckTop: "2H",
    });
    s.players[0].hasOpened = false;
    s.players[1].hasOpened = true;
    const plan = planTurn(s, "hard");
    const disc = plan.find(a => a.type === "discard");
    expect(disc.cardId).toBe("9C");
  });

  it("hard: won't feed a rank an opponent picked up from the discard this round", () => {
    // The opponent took a 7 off the pile — a declared collecting signal. Our
    // highest shed candidate is a 7; give up the next card down instead.
    const s = turnFixture({
      hand: ["7D", "5C", "2C"],
      table: [],
      deckTop: "3S",
    });
    s.matchEvents.pickups = [{ round: s.round, playerIdx: 1, rank: "7", suit: "H" }];
    const plan = planTurn(s, "hard");
    const disc = plan.find(a => a.type === "discard");
    expect(disc.cardId).not.toBe("7D");
  });
});

describe("planTurn — forecast matches the engine after a left run extension", () => {
  it("plans add-then-swap with positions the engine accepts", () => {
    // Regression: virtualState used to APPEND run additions, so after a left
    // extension every later positionIndex in the plan was off by the prepended
    // count and the engine rejected the swap ("Target isn't a wildcard").
    // Run Q-(W=K)-A of diamonds; J♦ prepends (shifting the wild right) and K♦
    // swaps the wild out. Both must apply cleanly through the real engine.
    const s = turnFixture({
      hand: ["JD", "KD", "9C", "5H", "8S"],
      table: [runSet("D", 12, [natSlot("QD"), wildSlot("2D", "K", "D"), natSlot("AD")], { id: "run1", ownerIndex: 0 })],
      deckTop: "3S",
    });
    s.wildcardRank = "2";
    const plan = planTurn(s, "hard");
    expect(plan.some(a => a.type === "add" && a.arrangement.added.some(c => c.card.id === "JD"))).toBe(true);
    expect(plan.some(a => a.type === "swap" && a.naturalCardId === "KD")).toBe(true);
    beginTurn(s);
    for (const a of plan) {
      const r = applyAction(s, a);
      expect(r.ok, `action ${a.type} failed: ${r.reason}`).toBe(true);
    }
    expect(s.players[0].hand.some(c => c.id === "2D")).toBe(true); // benny reclaimed
  });
});

describe("planTurn — dealer opening turn", () => {
  it("opens without drawing (the dealer's first turn has no draw)", () => {
    const s = makeCpuMatch(3, "hard");
    beginTurn(s); // dealer opening -> canAct
    const plan = planTurn(s, "hard");
    expect(plan[0].type).not.toBe("drawDeck");
    expect(plan[0].type).not.toBe("drawDiscard");
    expect(plan.at(-1).type).toBe("discard");
  });
});

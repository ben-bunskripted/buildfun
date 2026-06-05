// @vitest-environment jsdom
//
// Regression coverage for the hand drag/drop race that duplicated a card and
// blanked the hand: if the hand was rebuilt (renderHand → #hand.innerHTML = "")
// while a card was lifted out for a drag, the drag's placeholder was discarded,
// the lifted node was left orphaned in <body>, and the rebuilt hand showed a
// duplicate of the dragged card. The drop handler must detect the discarded
// placeholder and drop the lifted node instead of re-inserting it.
import { describe, it, expect, beforeEach } from "vitest";
import { makeHandReorderable } from "../../projects/benny-card-game/js/dragdrop.js";

function makeCard(id) {
  const el = document.createElement("div");
  el.className = "card in-hand";
  el.dataset.cardId = id;
  return el;
}

function pointer(type, opts = {}) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, {
    clientX: 0,
    clientY: 0,
    pointerType: "mouse",
    button: 0,
    pointerId: 1,
    ...opts,
  });
  return e;
}

function buildHand(ids) {
  const hand = document.createElement("div");
  hand.id = "hand";
  for (const id of ids) hand.appendChild(makeCard(id));
  document.body.appendChild(hand);
  return hand;
}

describe("makeHandReorderable — drag completes normally", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("returns the lifted card to the hand and reports the reorder", () => {
    const hand = buildHand(["AS", "2S", "3S"]);
    const reorders = [];
    let dragEnds = 0;
    makeHandReorderable(hand, (from, to) => reorders.push([from, to]), {
      onDragEnd: () => { dragEnds++; },
    });

    const card = hand.children[0];
    card.dispatchEvent(pointer("pointerdown", { clientX: 0, clientY: 0 }));
    // Move past the 6px threshold to start the drag, then release.
    window.dispatchEvent(pointer("pointermove", { clientX: 40, clientY: 0 }));
    window.dispatchEvent(pointer("pointerup", { clientX: 40, clientY: 0 }));

    // The dragged card is back in the hand and not duplicated.
    const ids = [...hand.children].map(c => c.dataset.cardId);
    expect(ids.filter(id => id === "AS")).toHaveLength(1);
    expect(hand.querySelectorAll(".drag-placeholder")).toHaveLength(0);
    expect(document.body.classList.contains("hand-dragging")).toBe(false);
    expect(reorders).toHaveLength(1);
    expect(dragEnds).toBe(1);
  });
});

describe("makeHandReorderable — hand rebuilt mid-drag", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("does not duplicate the dragged card when its placeholder is discarded", () => {
    const hand = buildHand(["AS", "2S", "3S"]);
    const reorders = [];
    let dragEnds = 0;
    makeHandReorderable(hand, (from, to) => reorders.push([from, to]), {
      onDragEnd: () => { dragEnds++; },
    });

    const card = hand.children[0];
    card.dispatchEvent(pointer("pointerdown", { clientX: 0, clientY: 0 }));
    window.dispatchEvent(pointer("pointermove", { clientX: 40, clientY: 0 }));

    // Drag is now active: card lifted to <body>, placeholder + hand-dragging set.
    expect(document.body.classList.contains("hand-dragging")).toBe(true);
    expect(card.parentElement).toBe(document.body);

    // Simulate a render rebuilding the hand from state mid-drag: it wipes #hand
    // (discarding the placeholder) and re-creates the dragged card fresh.
    hand.innerHTML = "";
    hand.appendChild(makeCard("AS"));
    hand.appendChild(makeCard("2S"));
    hand.appendChild(makeCard("3S"));

    window.dispatchEvent(pointer("pointerup", { clientX: 40, clientY: 0 }));

    // The hand holds exactly one of each card — the lifted node was dropped,
    // not re-inserted as a duplicate.
    const ids = [...hand.children].map(c => c.dataset.cardId).sort();
    expect(ids).toEqual(["2S", "3S", "AS"]);
    // The orphaned lifted node is gone from <body>.
    expect(document.body.querySelector("body > .card")).toBeNull();
    // A discarded placeholder must not trigger a bogus reorder.
    expect(reorders).toHaveLength(0);
    // The host still gets a chance to flush a deferred render.
    expect(dragEnds).toBe(1);
    expect(document.body.classList.contains("hand-dragging")).toBe(false);
  });
});

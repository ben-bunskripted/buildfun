// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderCard, renderCardBack, setCardStyle, getCardStyle } from "../../projects/benny-card-game/js/cards.js";
import { card } from "../helpers.js";

describe("renderCard — modern (default)", () => {
  it("tags the element and embeds the matching SVG art", () => {
    setCardStyle("modern");
    const el = renderCard(card("10S"));
    expect(el.classList.contains("card")).toBe(true);
    expect(el.classList.contains("is-modern")).toBe(true);
    expect(el.dataset.cardId).toBe("10S");
    const img = el.querySelector("img.card-art");
    expect(img).toBeTruthy();
    // "10" maps to "T" in the asset filename.
    expect(img.getAttribute("src")).toBe("assets/cards/TS.svg");
  });

  it("renders a wild banner only when wild, with the represented rank+suit", () => {
    setCardStyle("modern");
    const plain = renderCard(card("7H"));
    expect(plain.querySelector(".wild-banner")).toBeNull();

    const wild = renderCard(card("7H"), { wild: true, represents: { rank: "9", suit: "D" } });
    expect(wild.classList.contains("is-wild")).toBe(true);
    const rep = wild.querySelector(".wild-banner-rep");
    expect(rep.textContent).toBe("9♦");
  });

  it("applies extra class names from opts", () => {
    const el = renderCard(card("AS"), { className: "just-drawn selected" });
    expect(el.classList.contains("just-drawn")).toBe(true);
    expect(el.classList.contains("selected")).toBe(true);
  });
});

describe("renderCard — classic", () => {
  it("builds corner rank/suit DOM instead of an img", () => {
    setCardStyle("classic");
    const el = renderCard(card("QH"));
    expect(el.querySelector("img.card-art")).toBeNull();
    const corner = el.querySelector(".corner .rank");
    expect(corner.textContent).toBe("Q");
    expect(el.querySelector(".corner .suit").textContent).toBe("♥");
    setCardStyle("modern"); // restore for other tests
  });
});

describe("renderCardBack / style switch", () => {
  it("returns a face-down card div", () => {
    const el = renderCardBack();
    expect(el.classList.contains("card")).toBe(true);
    expect(el.classList.contains("back")).toBe(true);
  });
  it("getCardStyle reflects setCardStyle", () => {
    setCardStyle("classic");
    expect(getCardStyle()).toBe("classic");
    setCardStyle("modern");
    expect(getCardStyle()).toBe("modern");
  });
});

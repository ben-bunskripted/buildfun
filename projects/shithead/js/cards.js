// Card model + renderer for Sh!thead.
// Two render modes: "modern" uses the full-card SVG assets in assets/cards/;
// "classic" builds the card from corner indices + a pip grid + J/Q/K portraits.

import { RANKS, SUITS, SUIT_GLYPH, JOKER } from "./rules.js";

export { RANKS, SUITS, SUIT_GLYPH };

export function buildDeck() {
  const cards = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      cards.push({ id: `${r}${s}`, rank: r, suit: s });
    }
  }
  return cards;
}

// ---------- Style switch ----------
let CARD_STYLE = "modern";
export function setCardStyle(style) {
  CARD_STYLE = style === "classic" ? "classic" : "modern";
}
export function getCardStyle() { return CARD_STYLE; }

// ---------- Modern renderer (SVG assets) ----------
function assetName(rank, suit) {
  if (rank === JOKER) return suit === "1" ? "1J.svg" : "2J.svg";
  const r = rank === "10" ? "T" : rank;
  return `${r}${suit}.svg`;
}

// ---------- Classic renderer (DOM-built corners + pips + portraits) ----------
const PIP_LAYOUT = {
  "A": [{c:1,r:3,big:true}],
  "2": [{c:1,r:0},{c:1,r:6,f:1}],
  "3": [{c:1,r:0},{c:1,r:3},{c:1,r:6,f:1}],
  "4": [{c:0,r:0},{c:2,r:0},{c:0,r:6,f:1},{c:2,r:6,f:1}],
  "5": [{c:0,r:0},{c:2,r:0},{c:1,r:3},{c:0,r:6,f:1},{c:2,r:6,f:1}],
  "6": [{c:0,r:0},{c:2,r:0},{c:0,r:3},{c:2,r:3},{c:0,r:6,f:1},{c:2,r:6,f:1}],
  "7": [{c:0,r:0},{c:2,r:0},{c:1,r:1},{c:0,r:3},{c:2,r:3},{c:0,r:6,f:1},{c:2,r:6,f:1}],
  "8": [{c:0,r:0},{c:2,r:0},{c:1,r:1},{c:0,r:3},{c:2,r:3},{c:1,r:5,f:1},{c:0,r:6,f:1},{c:2,r:6,f:1}],
  "9": [{c:0,r:0},{c:2,r:0},{c:0,r:2},{c:2,r:2},{c:1,r:3},{c:0,r:4,f:1},{c:2,r:4,f:1},{c:0,r:6,f:1},{c:2,r:6,f:1}],
  "10":[{c:0,r:0},{c:2,r:0},{c:1,r:1},{c:0,r:2},{c:2,r:2},{c:1,r:5,f:1},{c:0,r:4,f:1},{c:2,r:4,f:1},{c:0,r:6,f:1},{c:2,r:6,f:1}],
};

function suitColorClass(suit) { return "suit-" + suit.toLowerCase(); }

function buildFaceHTML(rank, suit) {
  if (rank === "J" || rank === "Q" || rank === "K") {
    return `<div class="portrait">${portraitSVG(rank)}</div>`;
  }
  const layout = PIP_LAYOUT[rank];
  if (!layout) return "";
  const pips = layout.map((p) => {
    const cls = "pip" + (p.f ? " flip" : "") + (p.big ? " big" : "");
    return `<span class="${cls}" style="grid-column:${p.c+1};grid-row:${p.r+1};">${SUIT_GLYPH[suit]}</span>`;
  }).join("");
  return `<div class="face">${pips}</div>`;
}

function portraitSVG(rank) {
  if (rank === "J") {
    return `<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M28 86 L20 110 L80 110 L72 86 Z" fill="currentColor" opacity="0.7"/>
      <ellipse cx="50" cy="56" rx="15" ry="19" fill="none" stroke="currentColor" stroke-width="2.2"/>
      <circle cx="44" cy="55" r="1.8" fill="currentColor"/>
      <circle cx="56" cy="55" r="1.8" fill="currentColor"/>
      <path d="M43 65 Q50 69 57 65" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
      <path d="M22 38 C22 24 34 16 50 16 C66 16 78 24 78 38 L74 42 L26 42 Z" fill="currentColor"/>
    </svg>`;
  }
  if (rank === "Q") {
    return `<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M28 86 L18 110 L82 110 L72 86 Z" fill="currentColor" opacity="0.7"/>
      <ellipse cx="50" cy="58" rx="13" ry="17" fill="none" stroke="currentColor" stroke-width="2.2"/>
      <circle cx="45" cy="56" r="1.6" fill="currentColor"/>
      <circle cx="55" cy="56" r="1.6" fill="currentColor"/>
      <path d="M45 66 Q50 68 55 66" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <path d="M32 46 L38 28 L44 42 L50 22 L56 42 L62 28 L68 46 Z" fill="currentColor"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M26 86 L16 110 L84 110 L74 86 Z" fill="currentColor" opacity="0.7"/>
    <ellipse cx="50" cy="56" rx="15" ry="19" fill="none" stroke="currentColor" stroke-width="2.2"/>
    <circle cx="44" cy="54" r="1.8" fill="currentColor"/>
    <circle cx="56" cy="54" r="1.8" fill="currentColor"/>
    <path d="M36 62 Q42 80 50 82 Q58 80 64 62 Q58 70 50 70 Q42 70 36 62 Z" fill="currentColor" opacity="0.92"/>
    <path d="M28 44 L34 22 L42 38 L50 18 L58 38 L66 22 L72 44 Z" fill="currentColor"/>
    <rect x="48" y="4" width="4" height="12" fill="currentColor"/>
    <rect x="44" y="8" width="12" height="4" fill="currentColor"/>
  </svg>`;
}

// Render a card DOM element. opts:
//   className → extra classes
//   faceDown  → render the card back instead of the face
export function renderCard(card, opts = {}) {
  if (opts.faceDown) return renderCardBack(opts);
  const el = document.createElement("div");
  el.className = "card";
  if (CARD_STYLE === "classic") el.classList.add(suitColorClass(card.suit));
  else el.classList.add("is-modern");
  if (opts.className) el.classList.add(...opts.className.split(" "));
  el.dataset.cardId = card.id;
  el.dataset.rank = card.rank;

  if (CARD_STYLE === "classic" && card.rank === JOKER) {
    el.classList.remove(suitColorClass(card.suit));
    el.classList.add("joker");
    el.innerHTML = `
      <div class="corner top-left"><span class="rank">JKR</span><span class="suit">★</span></div>
      <div class="face joker-face"><span class="joker-star">★</span><span class="joker-word">JOKER</span></div>
      <div class="corner bottom-right"><span class="rank">JKR</span><span class="suit">★</span></div>`;
  } else if (CARD_STYLE === "classic") {
    el.innerHTML = `
      <div class="corner top-left">
        <span class="rank">${card.rank}</span>
        <span class="suit">${SUIT_GLYPH[card.suit]}</span>
      </div>
      ${buildFaceHTML(card.rank, card.suit)}
      <div class="corner bottom-right">
        <span class="rank">${card.rank}</span>
        <span class="suit">${SUIT_GLYPH[card.suit]}</span>
      </div>`;
  } else {
    el.innerHTML = `<img class="card-art" src="assets/cards/${assetName(card.rank, card.suit)}" alt="${card.rank}${card.suit}" draggable="false">`;
  }
  return el;
}

export function renderCardBack(opts = {}) {
  const el = document.createElement("div");
  el.className = "card back";
  if (opts.className) el.classList.add(...opts.className.split(" "));
  return el;
}

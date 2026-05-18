// Card model + renderer.
// - Builds the 52-card deck.
// - Two render modes: "modern" uses full-card SVG assets in assets/cards/;
//   "classic" builds the card from corners + pip grid + character portraits.

export const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
export const SUITS = ["S","H","D","C"];

export const SUIT_GLYPH = { S: "♠", H: "♥", D: "♦", C: "♣" };

// Sort priority: higher value first. Aces score 14 in hand; for sorting we treat A as 14.
export const RANK_VALUE = {
  "A": 14, "K": 13, "Q": 12, "J": 11,
  "10": 10, "9": 9, "8": 8, "7": 7, "6": 6,
  "5": 5, "4": 4, "3": 3, "2": 2,
};

// Hand-scoring (cards left in hand at round end). Wildcards override to 15 elsewhere.
export const CARD_POINTS = {
  "A": 14, "K": 13, "Q": 12, "J": 11,
  "10": 10, "9": 9, "8": 8, "7": 7, "6": 6,
  "5": 5, "4": 4, "3": 3, "2": 2,
};

// Stable suit ordering used only as tiebreaker when sorting by value.
const SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3 };

export function compareForSort(a, b, wildRank) {
  if (wildRank) {
    const aw = a.rank === wildRank;
    const bw = b.rank === wildRank;
    if (aw && !bw) return -1;
    if (bw && !aw) return 1;
  }
  const dv = RANK_VALUE[b.rank] - RANK_VALUE[a.rank];
  if (dv !== 0) return dv;
  return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
}

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
  const pips = layout.map(p => {
    const cls = "pip" + (p.f ? " flip" : "") + (p.big ? " big" : "");
    return `<span class="${cls}" style="grid-column:${p.c+1};grid-row:${p.r+1};">${SUIT_GLYPH[suit]}</span>`;
  }).join("");
  return `<div class="face">${pips}</div>`;
}

function portraitSVG(rank) {
  if (rank === "J") {
    return `<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M28 86 L20 110 L80 110 L72 86 Z" fill="currentColor" opacity="0.7"/>
      <rect x="80" y="60" width="2.5" height="28" fill="currentColor" opacity="0.85"/>
      <path d="M76 60 L86 60 L86 64 L76 64 Z" fill="currentColor"/>
      <path d="M81 54 L81 60" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M32 78 Q40 84 50 80 Q60 84 68 78 L72 86 Q60 92 50 86 Q40 92 28 86 Z" fill="currentColor"/>
      <ellipse cx="50" cy="56" rx="15" ry="19" fill="currentColor" fill-opacity="0.08"/>
      <ellipse cx="50" cy="56" rx="15" ry="19" fill="none" stroke="currentColor" stroke-width="2.2"/>
      <circle cx="44" cy="55" r="1.8" fill="currentColor"/>
      <circle cx="56" cy="55" r="1.8" fill="currentColor"/>
      <path d="M43 65 Q50 69 57 65" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
      <path d="M36 44 Q33 50 37 53" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
      <path d="M64 44 Q67 50 63 53" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
      <path d="M22 38 C22 24 34 16 50 16 C66 16 78 24 78 38 L74 42 L26 42 Z" fill="currentColor"/>
      <path d="M70 24 Q88 14 84 2 Q78 16 66 22 Z" fill="currentColor" opacity="0.85"/>
    </svg>`;
  }
  if (rank === "Q") {
    return `<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M28 86 L18 110 L82 110 L72 86 Z" fill="currentColor" opacity="0.7"/>
      <path d="M34 78 Q42 84 50 80 Q58 84 66 78 L70 86 Q60 92 50 86 Q40 92 30 86 Z" fill="currentColor"/>
      <path d="M32 52 Q22 76 30 98" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="M68 52 Q78 76 70 98" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round"/>
      <ellipse cx="50" cy="58" rx="13" ry="17" fill="currentColor" fill-opacity="0.08"/>
      <ellipse cx="50" cy="58" rx="13" ry="17" fill="none" stroke="currentColor" stroke-width="2.2"/>
      <circle cx="45" cy="56" r="1.6" fill="currentColor"/>
      <circle cx="55" cy="56" r="1.6" fill="currentColor"/>
      <path d="M45 66 Q50 68 55 66" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <path d="M32 46 L38 28 L44 42 L50 22 L56 42 L62 28 L68 46 Z" fill="currentColor"/>
      <circle cx="50" cy="30" r="2.2" fill="currentColor" opacity="0.5"/>
      <circle cx="38" cy="34" r="1.4" fill="currentColor" opacity="0.5"/>
      <circle cx="62" cy="34" r="1.4" fill="currentColor" opacity="0.5"/>
      <circle cx="84" cy="72" r="4.5" fill="currentColor"/>
      <circle cx="84" cy="72" r="2.2" fill="currentColor" opacity="0.5"/>
      <path d="M84 76.5 L82 96" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M82 86 Q76 86 76 92" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 100 110" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M26 86 L16 110 L84 110 L74 86 Z" fill="currentColor" opacity="0.7"/>
    <path d="M32 78 Q42 84 50 80 Q58 84 68 78 L74 86 Q60 92 50 86 Q40 92 26 86 Z" fill="currentColor"/>
    <rect x="84" y="58" width="2.5" height="50" fill="currentColor"/>
    <circle cx="85.25" cy="55" r="4.5" fill="currentColor"/>
    <circle cx="85.25" cy="55" r="2" fill="currentColor" opacity="0.4"/>
    <ellipse cx="50" cy="56" rx="15" ry="19" fill="currentColor" fill-opacity="0.08"/>
    <ellipse cx="50" cy="56" rx="15" ry="19" fill="none" stroke="currentColor" stroke-width="2.2"/>
    <circle cx="44" cy="54" r="1.8" fill="currentColor"/>
    <circle cx="56" cy="54" r="1.8" fill="currentColor"/>
    <path d="M36 62 Q42 80 50 82 Q58 80 64 62 Q58 70 50 70 Q42 70 36 62 Z" fill="currentColor" opacity="0.92"/>
    <path d="M40 64 Q45 66 50 64 Q55 66 60 64" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M28 44 L34 22 L42 38 L50 18 L58 38 L66 22 L72 44 Z" fill="currentColor"/>
    <rect x="48" y="4" width="4" height="12" fill="currentColor"/>
    <rect x="44" y="8" width="12" height="4" fill="currentColor"/>
    <rect x="28" y="42" width="44" height="2.5" fill="currentColor" opacity="0.6"/>
    <circle cx="50" cy="36" r="2.2" fill="currentColor" opacity="0.5"/>
    <circle cx="38" cy="38" r="1.5" fill="currentColor" opacity="0.5"/>
    <circle cx="62" cy="38" r="1.5" fill="currentColor" opacity="0.5"/>
  </svg>`;
}

// Renders a card DOM element. Options:
//   wild      → marks this card as a wildcard (rank matches round's wildcard rank)
//   represents → {rank, suit} when wildcard is sitting in a set. The underlying
//                card art stays the original wildcard; the wild banner shows the
//                represented rank+suit so you can see what it stands in for.
export function renderCard(card, opts = {}) {
  const el = document.createElement("div");
  el.className = "card";
  if (CARD_STYLE === "classic") el.classList.add(suitColorClass(card.suit));
  else el.classList.add("is-modern");
  if (opts.wild) el.classList.add("is-wild");
  if (opts.className) el.classList.add(...opts.className.split(" "));
  el.dataset.cardId = card.id;

  const wildBanner = opts.wild ? wildBannerHTML(opts.represents) : ``;

  if (CARD_STYLE === "classic") {
    el.innerHTML = `
      <div class="corner top-left">
        <span class="rank">${card.rank}</span>
        <span class="suit">${SUIT_GLYPH[card.suit]}</span>
      </div>
      ${buildFaceHTML(card.rank, card.suit)}
      <div class="corner bottom-right">
        <span class="rank">${card.rank}</span>
        <span class="suit">${SUIT_GLYPH[card.suit]}</span>
      </div>
      ${wildBanner}
    `;
  } else {
    el.innerHTML = `
      <img class="card-art" src="assets/cards/${assetName(card.rank, card.suit)}" alt="${card.rank}${card.suit}" draggable="false">
      ${wildBanner}
    `;
  }
  return el;
}

function wildBannerHTML(represents) {
  const rep = represents
    ? `<span class="wild-banner-rep">${represents.rank}${SUIT_GLYPH[represents.suit] || ""}</span>`
    : ``;
  return `<div class="wild-banner"><span class="wild-banner-label">WILD</span>${rep}</div>`;
}

export function renderCardBack() {
  const el = document.createElement("div");
  el.className = "card back";
  return el;
}

export function isWildcard(card, wildcardRank) {
  return card.rank === wildcardRank;
}

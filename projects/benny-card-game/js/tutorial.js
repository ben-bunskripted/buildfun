// Interactive first-time tutorial.
//
// Walks the user through one full round against a single CPU opponent with a
// pre-seeded deck so the deal is predictable. Each step either shows a
// centered modal (intro/outro) or a coach balloon anchored to the bottom of
// the screen while highlighting the UI element the user should interact with.
// Main wires `tutorial.notify(event, payload)` calls at the points where the
// user takes an action; the tutorial advances when the expected event arrives.

import { buildDeck } from "./cards.js";

let active = false;
let stepIdx = 0;
let steps = [];
let callbacks = null;
let coachEl = null;
let highlightedEls = [];

// Pre-arranged top of the round-1 deck.
//
// Round 1 wildcard rank is A.
// Players: [human (index 0), CPU dealer (index 1)].
// Deal order with dealerIndex=1: positions 0,2,4,6,8,10,12 → human;
// positions 1,3,5,7,9,11,13,14 → CPU (last is dealer's 8th).
// Position 15 is the top of the remaining deck — the human's draw on turn 2.
//
// Hands after the deal:
//   Human: 5C, 5D, 5H, 5S, 7S, 8S, AC
//     → after drawing JH on turn 2: 5C, 5D, 5H, 5S, 7S, 8S, AC, JH
//     → play 5C-5D-5H (number set), then 5S-7S-8S-AC (run with wild=6S),
//       discard JH to go out.
//   CPU dealer: 2C, 3D, 4H, 6C, JS, JC, QD, KH
//     → no sets / runs / wildcards available, just discards highest-value card.
const SEEDED_TOP = [
  "5C", "2C",
  "5D", "3D",
  "5H", "4H",
  "5S", "6C",
  "7S", "JS",
  "8S", "JC",
  "AC", "QD",
  "KH",
  "JH",
];

export function tutorialDeck() {
  const parse = (id) => ({ id, rank: id.slice(0, -1), suit: id.slice(-1) });
  const seededIds = new Set(SEEDED_TOP);
  const rest = buildDeck().filter(c => !seededIds.has(c.id));
  return SEEDED_TOP.map(parse).concat(rest);
}

export function isTutorialActive() { return active; }

// If the current step is asking for a specific card selection, return the
// allow-listed card ids. Main uses this to block taps on any other card.
export function selectableCardIds() {
  if (!active) return null;
  const step = steps[stepIdx];
  if (!step || step.awaitEvent !== "selectionChange") return null;
  return step.highlightCards || null;
}

export function startTutorial(cbs) {
  active = true;
  callbacks = cbs;
  stepIdx = 0;
  steps = buildSteps();
  ensureCoachEl();
  showStep(steps[stepIdx]);
}

export function endTutorial() {
  active = false;
  clearHighlights();
  if (coachEl) coachEl.classList.add("hidden");
  callbacks = null;
}

// Called from main.js at the points where the user takes an action.
export function notify(event, payload = {}) {
  if (!active) return;
  const step = steps[stepIdx];
  if (!step || !step.awaitEvent) return;
  if (step.awaitEvent !== event) return;
  if (step.awaitGuard && !step.awaitGuard(payload)) return;
  advance();
}

// ---------- step list ----------

function buildSteps() {
  return [
    {
      kind: "modal",
      text: "Welcome to Benny — a 14-round card game where the lowest total score wins. This tutorial walks you through one full round.",
      buttonLabel: "Next",
    },
    {
      kind: "modal",
      text: "Each round has a wildcard rank. This round, every Ace is a wildcard — it can stand in for any missing card inside a set or a run.",
      buttonLabel: "Next",
    },
    {
      kind: "modal",
      text: "Your opponent is the dealer this round, so they go first with 8 cards. Tap Watch to see their turn.",
      buttonLabel: "Watch",
      onAdvance: () => callbacks.beginGameplay(),
      // Stay paused until the pass screen lands, so the recap modal isn't
      // covered by the next coach.
      awaitEvent: "passScreenShown",
    },
    {
      kind: "coach",
      text: "Now it's your turn. Tap Show hand to pick it up.",
      targetSelector: "#pass-show",
      awaitEvent: "showHand",
    },
    {
      kind: "coach",
      text: "Every turn starts with a draw. Tap the deck to draw a card.",
      targetSelector: "#draw-pile",
      awaitEvent: "drawDeck",
    },
    {
      kind: "coach",
      text: "You drew a card — see the gold outline. Now make your first set: tap your three 5s — 5♣, 5♦, and 5♥.",
      targetSelector: "#hand",
      highlightCards: ["5C", "5D", "5H"],
      awaitEvent: "selectionChange",
      awaitGuard: (p) => {
        const sel = p.selectedIds;
        return sel && sel.size === 3
          && ["5C", "5D", "5H"].every(id => sel.has(id));
      },
    },
    {
      kind: "coach",
      text: "Tap Play set to put your three 5s on the table.",
      targetSelector: "#play-set-btn",
      awaitEvent: "playSet",
    },
    {
      kind: "coach",
      text: "Nice — that's a number set. Now let's build a spades run with your wildcard. Select 5♠, 7♠, 8♠, and the Ace of Clubs.",
      targetSelector: "#hand",
      highlightCards: ["5S", "7S", "8S", "AC"],
      awaitEvent: "selectionChange",
      awaitGuard: (p) => {
        const sel = p.selectedIds;
        return sel && sel.size === 4
          && ["5S", "7S", "8S", "AC"].every(id => sel.has(id));
      },
    },
    {
      kind: "coach",
      text: "Tap Play set. The wildcard fills the gap as 6♠, making the run 5♠-6♠-7♠-8♠.",
      targetSelector: "#play-set-btn",
      awaitEvent: "playSet",
    },
    {
      kind: "coach",
      text: "You have one card left. Tap it to select, then tap the discard pile — an empty hand means you go out and win the round.",
      targetSelector: "#discard-pile",
      awaitEvent: "discard",
    },
    {
      kind: "modal",
      text: "You went out! Your score this round is 0 — your opponent scores the cards still in their hand. After 14 rounds the lowest cumulative score wins. Tap Finish to leave the tutorial.",
      buttonLabel: "Finish",
      onAdvance: () => callbacks.exit(),
    },
  ];
}

// ---------- step rendering ----------

function showStep(step) {
  clearHighlights();
  if (!step) { endTutorial(); return; }
  ensureCoachEl();

  coachEl.classList.remove("hidden", "tutorial-coach-center", "tutorial-coach-bottom");
  coachEl.classList.add(step.kind === "modal" ? "tutorial-coach-center" : "tutorial-coach-bottom");

  const body = coachEl.querySelector(".tutorial-coach-body");
  body.textContent = step.text;

  const acts = coachEl.querySelector(".tutorial-coach-actions");
  acts.innerHTML = "";
  if (step.kind === "modal") {
    const btn = document.createElement("button");
    btn.className = "pill primary";
    btn.textContent = step.buttonLabel || "Next";
    btn.addEventListener("click", () => {
      if (step.onAdvance) step.onAdvance();
      if (step.awaitEvent) {
        // Hide the modal but keep stepIdx — the step advances when the
        // expected gameplay event fires.
        coachEl.classList.add("hidden");
      } else {
        advance();
      }
    });
    acts.appendChild(btn);
  }

  if (step.targetSelector) {
    highlightTarget(step.targetSelector);
  }
  if (step.highlightCards && step.highlightCards.length) {
    highlightCards(step.highlightCards);
  }
}

function advance() {
  stepIdx++;
  if (stepIdx >= steps.length) {
    endTutorial();
    return;
  }
  showStep(steps[stepIdx]);
}

// When the visible UI changes (e.g. hand re-rendered), the elements the
// current step is highlighting get replaced. Re-apply highlights to the live
// nodes so the glow follows the new DOM. Called from main.js after each
// renderAll while the tutorial is active.
export function refreshHighlights() {
  if (!active) return;
  const step = steps[stepIdx];
  if (!step) return;
  clearHighlights();
  if (step.targetSelector) highlightTarget(step.targetSelector);
  if (step.highlightCards && step.highlightCards.length) highlightCards(step.highlightCards);
}

function highlightTarget(selector) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.classList.add("tutorial-highlight");
  highlightedEls.push(el);
}

function highlightCards(ids) {
  for (const id of ids) {
    const el = document.querySelector(`.hand [data-card-id="${id}"]`);
    if (!el) continue;
    el.classList.add("tutorial-highlight");
    highlightedEls.push(el);
  }
}

function clearHighlights() {
  for (const el of highlightedEls) {
    el.classList.remove("tutorial-highlight");
  }
  highlightedEls = [];
}

function ensureCoachEl() {
  if (coachEl) return;
  coachEl = document.createElement("div");
  coachEl.id = "tutorial-coach";
  coachEl.className = "tutorial-coach hidden";
  coachEl.innerHTML = `
    <div class="tutorial-coach-body"></div>
    <div class="tutorial-coach-actions"></div>
  `;
  document.body.appendChild(coachEl);
}

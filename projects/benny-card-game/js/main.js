// Benny — UI controller.

import { renderCard, renderCardBack, compareForSort, SUIT_GLYPH, isWildcard, setCardStyle } from "./cards.js";
import { randomInt, shuffleInPlace } from "./rng.js";
import {
  createMatch, startNextRound, beginTurn, currentPlayer, topOfDiscard,
  drawFromDeck, drawFromDiscard, placeNewSet, addToSet, swapWildcard,
  discard, isMatchOver, advanceToNextRound, matchWinnerIndex,
  isNoWayOut, finalizeNoWayOut,
  WILDCARD_ORDER, ROUND_NAMES, TOTAL_ROUNDS, serialize, hydrate,
} from "./game.js";
import { validateNewSet, validateAddition, validateSwap, describeRunArrangement, describeAddition } from "./rules.js";
import { makeHandReorderable } from "./dragdrop.js";
import { planTurn } from "./ai.js";
import {
  createScoringMatch, startScoringRound, submitScoringRound,
  isScoringMatchOver, advanceScoringRound, scoringWinnerIndex,
} from "./scoring.js";
import { save as storageSave, load as storageLoad, clear as storageClear, loadPrefs, savePrefs, hasSnapshot, loadAll as storageLoadAll, MATCH_MODES } from "./storage.js";
import * as tutorial from "./tutorial.js";
import * as online from "./online.js";
import * as net from "./net.js";
import { loadProfiles, saveProfiles, buildMatchSummary, recordMatch, listKnownPlayers, achievementById, keyFor as profileKeyFor } from "./profiles.js";
import {
  ACHIEVEMENTS, PROGRESS_ACHIEVEMENTS, ALL_MODES, MODE_LABELS,
  readProgress, SUIT_GLYPHS, SUIT_NAMES,
} from "./achievements.js";

// ---------- App state ----------
let state = null;        // active match state (multiplayer/cpu) OR scoring state
let ui = {
  mode: "multiplayer",   // "multiplayer" | "cpu" | "scoring"
  selectedIds: new Set(),
  // Multiplayer setup
  numPlayers: 3,
  playerNames: ["", "", "", ""],
  dealerChoice: "random",
  // Solo setup — opponent names pulled fresh from the same pool as DEFAULT_NAMES (set below).
  solo: {
    humanName: "",
    oppCount: 2,
    opponents: [
      { name: "", difficulty: "medium" },
      { name: "", difficulty: "easy" },
      { name: "", difficulty: "hard" },
    ],
    dealerChoice: "random",
  },
  // Scoring setup
  scoring: {
    numPlayers: 3,
    playerNames: ["", "", "", ""],
    dealerChoice: "0",
  },
  // Pending UI views for the CPU runner — held across the modal "Next" click.
  pendingAfterCpu: null,
  // Visual preference: "modern" (SVG assets) | "classic" (DOM-built)
  cardStyle: "modern",
  // Hand layout: true = cards fan with heavy overlap + per-card tilt; false =
  // spread out with minimal overlap. Default fanned.
  handFanned: true,
  // Card-size override applied as `data-card-size` on <html>. "m" is the
  // breakpoint-driven default (no override); s/l/xl scale the --card-w/h vars.
  cardSize: "m",
  // When true, CPU turns play out as on-table card animations instead of the
  // recap modal. Persisted as prefs.animateCpu.
  animateCpu: false,
};

const CARD_SIZE_VALUES = new Set(["s", "m", "l", "xl"]);

function applyCardSizePref(size) {
  const value = CARD_SIZE_VALUES.has(size) ? size : "m";
  document.documentElement.dataset.cardSize = value;
}

// Update every card-size segmented control in the DOM to show `ui.cardSize`
// as active. Run whenever the value changes — either from the start screen,
// from a hamburger menu, or after a load.
function syncCardSizeSegs() {
  const segs = document.querySelectorAll("#card-size-seg, [data-menu-card-size]");
  segs.forEach(seg => {
    seg.querySelectorAll(".seg-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.size === ui.cardSize);
    });
  });
}

function setCardSize(size) {
  if (!CARD_SIZE_VALUES.has(size) || size === ui.cardSize) return;
  ui.cardSize = size;
  applyCardSizePref(size);
  savePrefs({ ...loadPrefs(), cardSize: size });
  syncCardSizeSegs();
  // The card sizing affects hand layout overlap + fan tilt, so re-run the
  // fitter. Safe to call when the hand is empty — it bails on n === 0.
  if (typeof layoutHand === "function") layoutHand();
}

// Apply persisted card style preference before any cards are rendered.
{
  const prefs = loadPrefs();
  if (prefs.cardStyle === "classic" || prefs.cardStyle === "modern") {
    ui.cardStyle = prefs.cardStyle;
  }
  if (typeof prefs.handFanned === "boolean") {
    ui.handFanned = prefs.handFanned;
  }
  if (CARD_SIZE_VALUES.has(prefs.cardSize)) {
    ui.cardSize = prefs.cardSize;
  }
  if (typeof prefs.animateCpu === "boolean") {
    ui.animateCpu = prefs.animateCpu;
  }
  setCardStyle(ui.cardStyle);
  applyCardSizePref(ui.cardSize);
}

// ---------- Persistence ----------
function persist() {
  if (!state) return;
  // Online matches live server-side — never write them to a local slot (a
  // stale snapshot would desync on resume; the room is the source of truth).
  if (online.isActive()) return;
  // The tutorial match is ephemeral — never write it to localStorage so a
  // reload doesn't leave the user a half-finished tutorial as a resumable
  // game on the start screen.
  if (state.isTutorial) return;
  storageSave({ mode: state.mode, state: serialize(state), ui: { mode: ui.mode } });
}
// Clear a saved slot. Defaults to the active match's mode; pass an explicit
// mode to clear a specific slot (e.g. the selected mode on the start screen).
function discardSave(mode) {
  const m = mode || (state && state.mode);
  if (m) storageClear(m);
}

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(el => el.classList.remove("active"));
  $(id).classList.add("active");
}
function toast(msg, ms = 1800) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add("hidden"), ms);
}

// ---------- Start screen ----------
// First slot is the device owner; their name is captured by the welcome modal
// on first launch and persisted in prefs. "Ben" is only the seed used before
// the user types theirs in.
const DEFAULT_NAMES = [(loadPrefs().userName || "").trim() || "Ben",
  ...shuffleInPlace(["Roxy","Kye","Tim","Wayne","Nath","Sean","Fiona","Jon","Zach"]).slice(0, 3)];
// Use the same shuffled picks for CPU opponent defaults so the suggested names line up across modes.
ui.solo.opponents.forEach((o, i) => { o.name = DEFAULT_NAMES[i + 1] || `CPU ${i + 1}`; });
function defaultName(i) { return DEFAULT_NAMES[i] || `Player ${i+1}`; }

function buildStart() {
  // Mode picker
  const modeSeg = $("mode-seg");
  modeSeg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    selectMode(btn.dataset.mode);
  });
  showModeBlock();

  // Multiplayer block
  const seg = $("player-count");
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    seg.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    ui.numPlayers = Number(btn.dataset.count);
    renderNameFields();
    renderDealerSelect();
  });
  renderNameFields();
  renderDealerSelect();

  // Solo block
  $("solo-name").value = ui.solo.humanName || defaultName(0);
  ui.solo.humanName = $("solo-name").value;
  $("solo-name").addEventListener("input", () => {
    ui.solo.humanName = $("solo-name").value.trim();
    renderSoloDealer();
  });
  const soloSeg = $("solo-opp-count");
  soloSeg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    soloSeg.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    ui.solo.oppCount = Number(btn.dataset.count);
    renderSoloOpponents();
    renderSoloDealer();
  });
  renderSoloOpponents();
  renderSoloDealer();

  // Scoring block
  const scSeg = $("scoring-player-count");
  scSeg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    scSeg.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    ui.scoring.numPlayers = Number(btn.dataset.count);
    renderScoringNames();
    renderScoringDealer();
  });
  renderScoringNames();
  renderScoringDealer();

  // Card style picker
  const cardSeg = $("card-style-seg");
  cardSeg.querySelectorAll(".seg-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.style === ui.cardStyle);
  });
  cardSeg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    cardSeg.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    ui.cardStyle = btn.dataset.style;
    setCardStyle(ui.cardStyle);
    savePrefs({ ...loadPrefs(), cardStyle: ui.cardStyle });
  });

  // Card size picker — overrides the breakpoint-driven default. The same
  // control is mirrored in the play/scoring hamburger menus; setCardSize()
  // keeps every seg in sync and re-lays out the hand.
  syncCardSizeSegs();

  // Animate CPU moves toggle.
  const animSeg = $("animate-cpu-seg");
  animSeg.querySelectorAll(".seg-btn").forEach(b => {
    b.classList.toggle("active", (b.dataset.anim === "on") === ui.animateCpu);
  });
  animSeg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    animSeg.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    ui.animateCpu = btn.dataset.anim === "on";
    savePrefs({ ...loadPrefs(), animateCpu: ui.animateCpu });
  });

  $("start-btn").addEventListener("click", onStartMatch);
  $("tutorial-btn").addEventListener("click", onStartTutorial);
  $("tutorial-foot-btn").addEventListener("click", onStartTutorial);
  $("tutorial-hide-btn").addEventListener("click", () => {
    savePrefs({ ...loadPrefs(), hideTutorial: true });
    applyTutorialVisibility();
  });
  applyTutorialVisibility();

  // Rules modal — opened from start screen, also from play / scoring top bars (wired in wireUp).
  const rulesModal = $("modal-rules");
  $("rules-btn").addEventListener("click", openRules);
  $("profile-btn").addEventListener("click", openProfileScreen);
  $("modal-rules-close").addEventListener("click", closeRules);
  rulesModal.addEventListener("click", (e) => {
    if (e.target === rulesModal) closeRules();
  });

  // Feedback modal — same opener pattern; submit intercepted below.
  const feedbackModal = $("modal-feedback");
  $("feedback-btn").addEventListener("click", openFeedback);
  $("modal-feedback-cancel").addEventListener("click", closeFeedback);
  $("feedback-thanks-close").addEventListener("click", closeFeedback);
  feedbackModal.addEventListener("click", (e) => {
    if (e.target === feedbackModal) closeFeedback();
  });
  $("feedback-form").addEventListener("submit", onFeedbackSubmit);
}

// ---------- Install link ----------
// Chrome/Edge/Android fire beforeinstallprompt when the PWA meets installability
// criteria. We stash the event and reveal the "Install Benny" link on the start
// screen so users have a discoverable install path (the menu option is buried).
let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return;
  const btn = $("install-btn");
  if (btn) btn.classList.remove("hidden");
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  const btn = $("install-btn");
  if (btn) btn.classList.add("hidden");
});

function wireInstallLink() {
  $("install-btn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      promptEvent.prompt();
      await promptEvent.userChoice;
    } catch (_err) { /* swallow — appinstalled will hide if they accepted */ }
    $("install-btn").classList.add("hidden");
  });
}

function openRules() { $("modal-rules").classList.remove("hidden"); }
function closeRules() { $("modal-rules").classList.add("hidden"); }

function openFeedback() {
  $("modal-feedback").classList.remove("hidden");
  $("feedback-form").classList.remove("hidden");
  $("feedback-thanks").classList.add("hidden");
  $("feedback-form").reset();
}
function closeFeedback() { $("modal-feedback").classList.add("hidden"); }

async function onFeedbackSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const submitBtn = $("feedback-submit");
  submitBtn.disabled = true;
  try {
    const body = new URLSearchParams(new FormData(form)).toString();
    const res = await fetch("/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    form.classList.add("hidden");
    $("feedback-thanks").classList.remove("hidden");
  } catch (_err) {
    toast("Couldn't send — try again in a moment.");
  } finally {
    submitBtn.disabled = false;
  }
}

function showModeBlock() {
  for (const m of ["multiplayer", "cpu", "scoring", "online"]) {
    const block = $(`mode-${m}`);
    if (block) block.classList.toggle("hidden", ui.mode !== m);
  }
  if (ui.mode === "online") refreshOnlineModeBlock();
  // Per-mode settings visibility:
  //  - Animate CPU moves only makes sense with a CPU opponent (Solo vs CPU).
  //  - Scoring mode renders no cards, so card style/size are irrelevant.
  const setShown = (id, shown) => $(id) && $(id).classList.toggle("hidden", !shown);
  setShown("field-animate-cpu", ui.mode === "cpu");
  setShown("field-card-style", ui.mode !== "scoring");
  setShown("field-card-size", ui.mode !== "scoring");
  // Online has its own create/join buttons in the block — the generic
  // "Start match" button and tutorial link don't apply.
  setShown("start-btn", ui.mode !== "online");
  setShown("tutorial-row", ui.mode !== "online" && !loadPrefs().hideTutorial);
  setShown("tutorial-foot-btn", ui.mode !== "online");
}

// Switch the selected mode, sync the segmented control + dependent UI, and
// refresh the resume banner so it reflects the newly-selected mode's save.
function selectMode(mode) {
  if (mode !== "online" && !MATCH_MODES.includes(mode)) return;
  ui.mode = mode;
  const seg = $("mode-seg");
  if (seg) seg.querySelectorAll(".seg-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  showModeBlock();
  renderResumeBanner();
}

function renderNameFields() {
  const wrap = $("name-fields");
  wrap.innerHTML = "";
  for (let i = 0; i < ui.numPlayers; i++) {
    if (!ui.playerNames[i]) ui.playerNames[i] = defaultName(i);
    const inp = document.createElement("input");
    inp.className = "name-input";
    inp.type = "text";
    inp.value = ui.playerNames[i];
    inp.maxLength = 20;
    inp.autocomplete = "off";
    inp.placeholder = `Player ${i + 1} name`;
    inp.addEventListener("input", () => {
      ui.playerNames[i] = inp.value.trim();
      renderDealerSelect();
    });
    wrap.appendChild(inp);
  }
}
function renderDealerSelect() {
  const sel = $("dealer-select");
  const prev = ui.dealerChoice;
  sel.innerHTML = "";
  const optR = document.createElement("option");
  optR.value = "random"; optR.textContent = "Random (slot reveal)";
  sel.appendChild(optR);
  for (let i = 0; i < ui.numPlayers; i++) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = ui.playerNames[i] || defaultName(i);
    sel.appendChild(o);
  }
  sel.value = (prev === "random" || Number(prev) < ui.numPlayers) ? prev : "random";
  ui.dealerChoice = sel.value;
  sel.onchange = () => { ui.dealerChoice = sel.value; };
}

function renderSoloOpponents() {
  const wrap = $("solo-opponents");
  wrap.innerHTML = "";
  for (let i = 0; i < ui.solo.oppCount; i++) {
    const opp = ui.solo.opponents[i];
    const row = document.createElement("div");
    row.className = "opp-row";
    const nameInp = document.createElement("input");
    nameInp.className = "name-input";
    nameInp.type = "text";
    nameInp.value = opp.name;
    nameInp.maxLength = 20;
    nameInp.placeholder = `Opponent ${i + 1}`;
    nameInp.autocomplete = "off";
    nameInp.addEventListener("input", () => { opp.name = nameInp.value.trim(); renderSoloDealer(); });
    const diffSel = document.createElement("select");
    diffSel.className = "select";
    for (const d of ["easy", "medium", "hard"]) {
      const o = document.createElement("option");
      o.value = d; o.textContent = d[0].toUpperCase() + d.slice(1);
      diffSel.appendChild(o);
    }
    diffSel.value = opp.difficulty;
    diffSel.addEventListener("change", () => { opp.difficulty = diffSel.value; });
    row.appendChild(nameInp);
    row.appendChild(diffSel);
    wrap.appendChild(row);
  }
}

function renderSoloDealer() {
  const sel = $("solo-dealer-select");
  const names = [ui.solo.humanName || defaultName(0), ...ui.solo.opponents.slice(0, ui.solo.oppCount).map(o => o.name || "CPU")];
  const prev = ui.solo.dealerChoice;
  sel.innerHTML = "";
  const optR = document.createElement("option");
  optR.value = "random"; optR.textContent = "Random (slot reveal)";
  sel.appendChild(optR);
  for (let i = 0; i < names.length; i++) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = names[i];
    sel.appendChild(o);
  }
  sel.value = (prev === "random" || Number(prev) < names.length) ? prev : "random";
  ui.solo.dealerChoice = sel.value;
  sel.onchange = () => { ui.solo.dealerChoice = sel.value; };
}

function renderScoringNames() {
  const wrap = $("scoring-name-fields");
  wrap.innerHTML = "";
  for (let i = 0; i < ui.scoring.numPlayers; i++) {
    if (!ui.scoring.playerNames[i]) ui.scoring.playerNames[i] = defaultName(i);
    const inp = document.createElement("input");
    inp.className = "name-input";
    inp.type = "text";
    inp.value = ui.scoring.playerNames[i];
    inp.maxLength = 20;
    inp.autocomplete = "off";
    inp.placeholder = `Player ${i + 1} name`;
    inp.addEventListener("input", () => {
      ui.scoring.playerNames[i] = inp.value.trim();
      renderScoringDealer();
    });
    wrap.appendChild(inp);
  }
}

function renderScoringDealer() {
  const sel = $("scoring-dealer-select");
  if (!sel) return;
  const names = [];
  for (let i = 0; i < ui.scoring.numPlayers; i++) {
    names.push((ui.scoring.playerNames[i] || "").trim() || defaultName(i));
  }
  const prev = ui.scoring.dealerChoice;
  sel.innerHTML = "";
  const optR = document.createElement("option");
  optR.value = "random"; optR.textContent = "Random";
  sel.appendChild(optR);
  for (let i = 0; i < names.length; i++) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = names[i];
    sel.appendChild(o);
  }
  sel.value = (prev === "random" || Number(prev) < names.length) ? prev : "0";
  ui.scoring.dealerChoice = sel.value;
  sel.onchange = () => { ui.scoring.dealerChoice = sel.value; };
}

function onStartMatch() {
  const mode = ui.mode;
  const start = () => {
    if (mode === "scoring") return startScoringMatch();
    if (mode === "cpu") return startSoloMatch();
    return startMultiplayerMatch();
  };
  // Only the selected mode's slot is at risk — other modes' saves are untouched.
  if (hasSnapshot(mode)) {
    showConfirm({
      title: `Start a new ${MODE_TITLES[mode]} match?`,
      body: `You have a saved ${MODE_TITLES[mode]} match in progress. Starting a new one will overwrite it. Your other saved games are kept.`,
      confirmLabel: "Start new",
      onConfirm: () => { storageClear(mode); start(); },
    });
    return;
  }
  start();
}

const MODE_TITLES = { multiplayer: "Multiplayer", cpu: "Solo vs CPU", scoring: "Scoring", online: "Online" };

// Simple modal-confirm wrapper. Pulls in the static markup defined in index.html.
function showConfirm({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", onConfirm }) {
  const modal = $("modal-confirm");
  $("modal-confirm-title").textContent = title;
  $("modal-confirm-body").textContent = body || "";
  const yes = $("modal-confirm-yes");
  const no = $("modal-confirm-no");
  yes.textContent = confirmLabel;
  no.textContent = cancelLabel;
  const close = () => { modal.classList.add("hidden"); yes.onclick = null; no.onclick = null; };
  yes.onclick = () => { close(); onConfirm && onConfirm(); };
  no.onclick = close;
  modal.classList.remove("hidden");
}

function startMultiplayerMatch() {
  const names = [];
  for (let i = 0; i < ui.numPlayers; i++) {
    names.push((ui.playerNames[i] || "").trim() || defaultName(i));
  }
  const isRandom = ui.dealerChoice === "random";
  const dealerIndex = isRandom ? randomInt(ui.numPlayers) : Number(ui.dealerChoice);
  state = createMatch(names, dealerIndex, { mode: "multiplayer" });
  startMatchSequence(names, dealerIndex, isRandom);
}

function startSoloMatch() {
  const humanName = (ui.solo.humanName || "").trim() || defaultName(0);
  const opps = ui.solo.opponents.slice(0, ui.solo.oppCount);
  const names = [humanName, ...opps.map((o, i) => (o.name || `CPU ${i+1}`))];
  const kinds = ["human", ...opps.map(() => "cpu")];
  const diffs = [undefined, ...opps.map(o => o.difficulty)];
  const isRandom = ui.solo.dealerChoice === "random";
  const dealerIndex = isRandom ? randomInt(names.length) : Number(ui.solo.dealerChoice);
  state = createMatch(names, dealerIndex, { mode: "cpu", playerKinds: kinds, difficulties: diffs });
  startMatchSequence(names, dealerIndex, isRandom);
}

function startMatchSequence(names, dealerIndex, isRandom) {
  if (isRandom) {
    showScreen("screen-reveal");
    runReveal(names, dealerIndex, () => {
      startNextRound(state);
      persist();
      routeTurnStart();
    });
  } else {
    startNextRound(state);
    persist();
    routeTurnStart();
  }
}

function startScoringMatch() {
  const names = [];
  for (let i = 0; i < ui.scoring.numPlayers; i++) {
    names.push((ui.scoring.playerNames[i] || "").trim() || defaultName(i));
  }
  const isRandom = ui.scoring.dealerChoice === "random";
  const dealerIndex = isRandom
    ? randomInt(names.length)
    : Math.min(Number(ui.scoring.dealerChoice) || 0, names.length - 1);
  state = createScoringMatch(names, dealerIndex);
  const begin = () => {
    startScoringRound(state);
    persist();
    goScoringRoundScreen();
  };
  // Random dealer gets the same slot-machine reveal the play modes use.
  if (isRandom) {
    showScreen("screen-reveal");
    runReveal(names, dealerIndex, begin);
  } else {
    begin();
  }
}

// ---------- Tutorial entry ----------
function applyTutorialVisibility() {
  const row = $("tutorial-row");
  if (!row) return;
  // Once the user picks "Hide", the tutorial row stays hidden across reloads.
  // Clearing localStorage is the escape hatch — first-time onboarding doesn't
  // need a second-class re-show affordance.
  row.classList.toggle("hidden", !!loadPrefs().hideTutorial);
}

function onStartTutorial() {
  // The tutorial state is never persisted (see `persist()`), so an existing
  // saved match remains untouched — no confirmation needed.
  startTutorialMatch();
}

function startTutorialMatch() {
  const humanName = (loadPrefs().userName || "").trim() || "You";
  const names = [humanName, "Coach"];
  const kinds = ["human", "cpu"];
  const diffs = [undefined, "medium"];
  // CPU is the dealer so the human draws on turn 1 (the standard turn shape).
  state = createMatch(names, 1, { mode: "cpu", playerKinds: kinds, difficulties: diffs });
  state.isTutorial = true;
  startNextRound(state, { deck: tutorial.tutorialDeck() });
  persist();
  // Tutorial drives screen transitions via callbacks: it shows intro modals,
  // then asks us to begin gameplay (which kicks off the CPU's dealer turn),
  // and finally exits back to the start screen when the user finishes.
  tutorial.startTutorial({
    beginGameplay: () => { routeTurnStart(); },
    exit: () => {
      tutorial.endTutorial();
      // Tutorial state was never persisted (see `persist()` / `isTutorial`),
      // so dropping the in-memory state is enough — any prior real match
      // snapshot on the start screen survives untouched.
      state = null;
      ui.selectedIds.clear();
      renderResumeBanner();
      showScreen("screen-start");
    },
  });
}

// ---------- Dealer reveal (slot-machine reel) ----------
function runReveal(names, finalIndex, onDone) {
  const reel = $("reel");
  const nameEl = $("reveal-name");
  const cont = $("reveal-continue");
  cont.classList.add("hidden");
  nameEl.textContent = "";
  reel.innerHTML = "";

  const ITEM_H = 60;
  const FRAME_H = 200;
  const cycles = 8;
  for (let c = 0; c < cycles; c++) {
    for (const n of names) {
      const d = document.createElement("div");
      d.className = "reel-item";
      d.textContent = n;
      reel.appendChild(d);
    }
  }
  const targetIdx = (cycles - 2) * names.length + finalIndex;
  const targetY = targetIdx * ITEM_H + ITEM_H / 2 - FRAME_H / 2;

  const duration = 2600;
  const start = performance.now();
  function frame(t) {
    const elapsed = t - start;
    const p = Math.min(1, elapsed / duration);
    const ease = 1 - Math.pow(1 - p, 3.5);
    reel.style.transform = `translateY(${-(targetY * ease)}px)`;
    if (p < 1) requestAnimationFrame(frame);
    else {
      nameEl.textContent = `${names[finalIndex]} deals`;
      cont.classList.remove("hidden");
      cont.onclick = onDone;
    }
  }
  requestAnimationFrame(frame);
}

// ---------- Turn router ----------
// Called at the start of a turn (after deal, after a discard, after a CPU recap).
// Sends humans to the pass screen and CPUs to the invisible runner.
function routeTurnStart() {
  // Online play has its own router: it maps the active seat to this device,
  // drives the spectator lock, and never shows the hot-seat pass screen.
  if (online.isActive()) { online.route(); return; }
  if (state.phase === "roundOver") { goRoundEnd(); return; }
  const p = currentPlayer(state);
  if (p.kind === "cpu") { runCpuTurn(); return; }
  // Resume-mid-turn: phase already advanced past "passing" before the snapshot,
  // so don't show the pass screen (which would call beginTurn and clobber phase
  // back to "mustDraw", letting the player draw a second time).
  if (state.phase === "mustDraw" || state.phase === "canAct") {
    ui.selectedIds.clear();
    showScreen("screen-play");
    renderAll();
    return;
  }
  // Solo vs CPU has no device to pass — drop the human straight into play.
  if (state.mode === "cpu" && p.kind === "human") {
    beginTurn(state);
    ui.selectedIds.clear();
    showScreen("screen-play");
    renderAll();
    tutorial.notify("showHand");
    return;
  }
  goPassScreen();
}

// ---------- Pass-to-player screen ----------
function goPassScreen() {
  showScreen("screen-pass");
  const p = currentPlayer(state);
  $("pass-name").textContent = p.name;
  const sub = state.dealerOpeningPending && state.currentPlayerIndex === state.dealerIndex
    ? "Dealer opens: no draw, may play, must discard."
    : "Draw → optionally play → discard.";
  $("pass-sub").textContent = sub;
  $("pass-show").onclick = () => {
    beginTurn(state);
    ui.selectedIds.clear();
    showScreen("screen-play");
    renderAll();
    tutorial.notify("showHand");
  };
  tutorial.notify("passScreenShown");
}

// ---------- CPU turn driver ----------
function runCpuTurn() {
  const player = currentPlayer(state);
  beginTurn(state);
  const plan = planTurn(state, player.difficulty || "medium");

  if (ui.animateCpu) {
    runCpuTurnAnimated(player, plan);
  } else {
    runCpuTurnInstant(player, plan);
  }
}

// Run every action in one shot, then show the recap modal. This is the path
// used when `ui.animateCpu` is off (the default).
function runCpuTurnInstant(player, plan) {
  let roundWon = false;
  for (const action of plan) {
    const r = applyCpuAction(action);
    if (action.type === "discard" && r && r.ok && r.wonRound) roundWon = true;
    if (!r || !r.ok) {
      console.warn("CPU action failed:", action, r);
      break;
    }
  }
  if (!roundWon && state.phase === "canAct") {
    const me = currentPlayer(state);
    if (me.hand.length) {
      const fallback = me.hand[me.hand.length - 1];
      const r = discard(state, fallback.id);
      if (r.ok && r.wonRound) roundWon = true;
      plan.push({ type: "discard", cardId: fallback.id, narration: `discarded ${fallback.rank}${SUIT_GLYPH[fallback.suit]}` });
    }
  }
  persist();
  showCpuRecap(player.name, plan, roundWon);
}

function applyCpuAction(action) {
  if (action.type === "drawDeck") return drawFromDeck(state);
  if (action.type === "drawDiscard") return drawFromDiscard(state);
  if (action.type === "play") return placeNewSet(state, action.arrangement);
  if (action.type === "add") return addToSet(state, action.setId, action.arrangement);
  if (action.type === "swap") return swapWildcard(state, action.setId, action.positionIndex, action.naturalCardId);
  if (action.type === "discard") return discard(state, action.cardId);
  return null;
}

function showCpuRecap(playerName, plan, roundWon) {
  const modal = $("modal-cpu-recap");
  $("cpu-recap-title").textContent = `${playerName} (CPU)`;
  const list = $("cpu-recap-list");
  list.innerHTML = "";
  for (const a of plan) {
    const li = document.createElement("li");
    li.textContent = a.narration || a.type;
    list.appendChild(li);
  }
  if (roundWon) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>Won the round!</strong>`;
    list.appendChild(li);
  }
  modal.classList.remove("hidden");
  $("cpu-recap-next").onclick = () => {
    modal.classList.add("hidden");
    routeTurnStart();
  };
}

// ---------- Animated CPU turn ----------
const ANIM_STEP_MS = 460;          // duration of a single card glide
const ANIM_GAP_MS = 140;           // pause between consecutive steps

function rectOf(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}
function cpuRowEl(playerIdx) {
  return document.querySelectorAll("#all-melds .other-player")[playerIdx] || null;
}
function rectOfCpuRow(playerIdx) {
  const row = cpuRowEl(playerIdx);
  if (!row) return null;
  // Aim at the right side of the row's header so the deck/discard pile is a
  // long way away — makes the motion visually obvious.
  const r = row.getBoundingClientRect();
  // A virtual "card slot" sized to the current --card-w.
  const cs = getComputedStyle(document.documentElement);
  const w = parseFloat(cs.getPropertyValue("--card-w")) || 60;
  const h = parseFloat(cs.getPropertyValue("--card-h")) || 92;
  return { left: r.right - w - 8, top: r.top + 6, width: w, height: h };
}
function rectOfMeldCard(setId, positionIndex) {
  const meld = document.querySelector(`#all-melds .meld[data-set-id="${setId}"]`);
  if (!meld) return null;
  const cards = meld.querySelectorAll(".card");
  if (positionIndex >= cards.length) return null;
  return rectOf(cards[positionIndex]);
}

function flyEl(el, fromRect, toRect, opts = {}) {
  el.classList.add("flying-card");
  Object.assign(el.style, {
    position: "fixed",
    left: fromRect.left + "px",
    top: fromRect.top + "px",
    width: fromRect.width + "px",
    height: fromRect.height + "px",
    margin: "0",
    transition: `left ${ANIM_STEP_MS}ms cubic-bezier(.4,.06,.2,1), top ${ANIM_STEP_MS}ms cubic-bezier(.4,.06,.2,1), width ${ANIM_STEP_MS}ms cubic-bezier(.4,.06,.2,1), height ${ANIM_STEP_MS}ms cubic-bezier(.4,.06,.2,1), opacity ${ANIM_STEP_MS}ms ease-out`,
    zIndex: "240",
    pointerEvents: "none",
  });
  el.style.setProperty("--card-w", fromRect.width + "px");
  el.style.setProperty("--card-h", fromRect.height + "px");
  document.body.appendChild(el);
  el.offsetHeight;       // reflow so the transition runs from the from-rect
  Object.assign(el.style, {
    left: toRect.left + "px",
    top: toRect.top + "px",
    width: toRect.width + "px",
    height: toRect.height + "px",
    opacity: opts.fadeOut ? "0" : "1",
  });
  el.style.setProperty("--card-w", toRect.width + "px");
  el.style.setProperty("--card-h", toRect.height + "px");
  return new Promise(resolve => {
    setTimeout(() => { el.remove(); resolve(); }, ANIM_STEP_MS + 20);
  });
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runCpuTurnAnimated(player, plan) {
  // Surface the play screen first — the dealer's opening CPU turn arrives
  // straight from the reveal screen with the play DOM still inactive.
  showScreen("screen-play");
  renderAll();
  // Brief lead-in so the user sees the CPU's row before the deck flickers.
  const playerIdx = state.players.indexOf(player);
  const row = cpuRowEl(playerIdx);
  if (row) row.classList.add("is-cpu-thinking");
  // Lock the play screen into "spectator" mode so the human's hand stays
  // visible and the action buttons don't react to clicks during the CPU's
  // turn. Cleared in the finally block.
  document.body.classList.add("cpu-animating");
  await pause(280);

  let roundWon = false;
  try {
    for (const action of plan) {
      const r = await stepCpuAnimated(action);
      if (action.type === "discard" && r && r.ok && r.wonRound) roundWon = true;
      if (!r || !r.ok) break;
    }
    if (!roundWon && state.phase === "canAct") {
      const me = currentPlayer(state);
      if (me.hand.length) {
        const fallback = me.hand[me.hand.length - 1];
        const act = { type: "discard", cardId: fallback.id, narration: `discarded ${fallback.rank}${SUIT_GLYPH[fallback.suit]}` };
        plan.push(act);
        const r = await stepCpuAnimated(act);
        if (r && r.ok && r.wonRound) roundWon = true;
      }
    }
  } finally {
    if (row) row.classList.remove("is-cpu-thinking");
    document.body.classList.remove("cpu-animating");
  }
  persist();
  if (roundWon) {
    await pause(400);
    goRoundEnd();
  } else {
    await pause(200);
    routeTurnStart();
  }
}

// During a CPU animated turn we render only the PUBLIC parts of state: the
// table, the deck/discard piles, and the top bar. The hand-section is left
// untouched so the human keeps seeing their own cards.
function renderPublicState() {
  renderTopBar();
  renderAllMelds();
  renderMiddle();
  requestAnimationFrame(updateMeldOverflowFlags);
}

// Apply one CPU action, then animate the visual delta. Returns the action
// result so the caller can detect roundWon / failures.
async function stepCpuAnimated(action) {
  const playerIdx = state.currentPlayerIndex;
  // Capture pre-mutation rects — some sources disappear after the engine runs.
  const drawPileR = rectOf(document.getElementById("draw-pile"));
  const discardR = rectOf(document.querySelector("#discard-host > *") || document.getElementById("discard-pile"));
  const cpuR = rectOfCpuRow(playerIdx);
  // For swap: capture the wild card's slot before it's replaced.
  let wildSlotR = null;
  let wildCardData = null;
  if (action.type === "swap") {
    wildSlotR = rectOfMeldCard(action.setId, action.positionIndex);
    const set = state.table.find(s => s.id === action.setId);
    if (set) wildCardData = { card: set.cards[action.positionIndex].card, represents: { rank: set.cards[action.positionIndex].representsRank, suit: set.type === "run" ? set.cards[action.positionIndex].representsSuit : null } };
  }
  // For discard: the card moving and its top-of-discard target rect (preview).
  let discardedCardData = null;
  if (action.type === "discard") {
    discardedCardData = state.players[playerIdx].hand.find(c => c.id === action.cardId);
  }
  // For drawDiscard: peek the top card so we can fly its face.
  let topDiscardCard = null;
  if (action.type === "drawDiscard") {
    topDiscardCard = state.discardPile[state.discardPile.length - 1];
  }

  const result = applyCpuAction(action);
  if (!result || !result.ok) return result;
  renderPublicState();

  // Animate based on what just happened.
  const flights = [];
  if (action.type === "drawDeck") {
    // Face-down card from deck → CPU row, fade out (we don't reveal).
    if (drawPileR && cpuR) {
      const ghost = renderCardBack();
      flights.push(flyEl(ghost, drawPileR, cpuR, { fadeOut: true }));
    }
  } else if (action.type === "drawDiscard") {
    if (discardR && cpuR && topDiscardCard) {
      const wild = isWildcard(topDiscardCard, state.wildcardRank);
      const ghost = renderCard(topDiscardCard, { wild });
      flights.push(flyEl(ghost, discardR, cpuR, { fadeOut: true }));
    }
  } else if (action.type === "play") {
    // Each new card in the meld animates from the CPU row → its slot.
    if (cpuR) {
      const newSet = state.table[state.table.length - 1];
      if (newSet) {
        for (let i = 0; i < newSet.cards.length; i++) {
          const dest = rectOfMeldCard(newSet.id, i);
          if (!dest) continue;
          const c = newSet.cards[i];
          const opts = c.isWild ? { wild: true, represents: { rank: c.representsRank, suit: newSet.type === "run" ? c.representsSuit : null } } : {};
          const ghost = renderCard(c.card, opts);
          flights.push(flyEl(ghost, cpuR, dest));
        }
      }
    }
  } else if (action.type === "add") {
    if (cpuR) {
      const set = state.table.find(s => s.id === action.setId);
      if (set) {
        // The added cards are the most-recently-appended ones for number sets;
        // for runs the layout can re-sort, so just animate the cards whose ids
        // match the arrangement's added[] list.
        const addedIds = new Set((action.arrangement.added || []).map(a => a.card.id));
        for (let i = 0; i < set.cards.length; i++) {
          if (!addedIds.has(set.cards[i].card.id)) continue;
          const dest = rectOfMeldCard(set.id, i);
          if (!dest) continue;
          const c = set.cards[i];
          const opts = c.isWild ? { wild: true, represents: { rank: c.representsRank, suit: set.type === "run" ? c.representsSuit : null } } : {};
          const ghost = renderCard(c.card, opts);
          flights.push(flyEl(ghost, cpuR, dest));
        }
      }
    }
  } else if (action.type === "swap") {
    // Wild flies out to the CPU; natural flies in.
    if (wildSlotR && cpuR && wildCardData) {
      const wildGhost = renderCard(wildCardData.card, { wild: true, represents: wildCardData.represents });
      flights.push(flyEl(wildGhost, wildSlotR, cpuR, { fadeOut: true }));
    }
    const dest = rectOfMeldCard(action.setId, action.positionIndex);
    if (cpuR && dest) {
      const set = state.table.find(s => s.id === action.setId);
      if (set) {
        const naturalSlot = set.cards[action.positionIndex];
        const ghost = renderCard(naturalSlot.card, {});
        flights.push(flyEl(ghost, cpuR, dest));
      }
    }
  } else if (action.type === "discard") {
    const newTopR = rectOf(document.querySelector("#discard-host > *"));
    if (cpuR && newTopR && discardedCardData) {
      const wild = discardedCardData.rank === state.wildcardRank;
      const ghost = renderCard(discardedCardData, { wild });
      flights.push(flyEl(ghost, cpuR, newTopR));
    }
  }

  await Promise.all(flights);
  await pause(ANIM_GAP_MS);
  return result;
}

// ---------- Play screen rendering ----------
function renderAll() {
  renderTopBar();
  renderAllMelds();
  renderMiddle();
  renderHand();
  renderActions();
  // The tutorial highlights live nodes; re-apply after every re-render so the
  // glow follows freshly-built hand cards / table cards.
  tutorial.refreshHighlights();
  // Defer one tick so the browser has measured the new card widths.
  requestAnimationFrame(updateMeldOverflowFlags);
}

// Toggle .has-overflow-left / .has-overflow-right on every meld whose cards
// exceed the visible scroll width. Called after each render and on resize /
// meld scroll so the gold edge fades stay accurate.
function updateMeldOverflowFlags() {
  const melds = document.querySelectorAll("#all-melds .meld");
  melds.forEach(meldOverflowUpdate);
}
function meldOverflowUpdate(meld) {
  const max = meld.scrollWidth - meld.clientWidth;
  if (max <= 2) {
    meld.classList.remove("has-overflow-left", "has-overflow-right");
    return;
  }
  meld.classList.toggle("has-overflow-left", meld.scrollLeft > 2);
  meld.classList.toggle("has-overflow-right", meld.scrollLeft < max - 2);
}

function renderTopBar() {
  $("bar-round").textContent = ROUND_NAMES[state.round - 1] || state.round;
  $("bar-wild").textContent = state.wildcardRank;
  $("bar-turn").textContent = currentPlayer(state).name;
}

function renderAllMelds() {
  const wrap = $("all-melds");
  wrap.innerHTML = "";
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    const row = document.createElement("div");
    row.className = "other-player";
    if (i === state.currentPlayerIndex) row.classList.add("is-current");
    const head = document.createElement("div");
    head.className = "other-player-head";
    const name = document.createElement("div");
    name.className = "player-name";
    // In solo mode the "(you)" tag follows the human's row (always the same
    // row); in multiplayer it follows the active turn (since the pass screen
    // gates who's looking at the device).
    const isYou = online.isActive()
      ? i === online.mySeat()
      : state.mode === "cpu"
        ? p.kind === "human"
        : i === state.currentPlayerIndex;
    name.textContent = isYou ? `${p.name} (you)` : p.name;
    if (i === state.dealerIndex) {
      const chip = document.createElement("span");
      chip.className = "dealer-chip";
      chip.textContent = "Dealer";
      name.appendChild(chip);
    }
    head.appendChild(name);
    const meta = document.createElement("div");
    meta.className = "player-meta";
    const hc = document.createElement("span");
    hc.className = "hand-count";
    hc.textContent = `${p.hand.length}`;
    meta.appendChild(hc);
    const sc = document.createElement("span");
    sc.className = "score-chip";
    sc.textContent = `${p.score}`;
    meta.appendChild(sc);
    head.appendChild(meta);
    row.appendChild(head);
    row.appendChild(renderPlayerMelds(i));
    wrap.appendChild(row);
  }
}

function renderPlayerMelds(playerIdx) {
  const container = document.createElement("div");
  container.className = "melds";
  const sets = state.table.filter(s => s.ownerIndex === playerIdx);
  if (!sets.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.fontSize = "12px";
    empty.textContent = playerIdx === state.currentPlayerIndex
      ? "Play 3+ matching cards to open this round."
      : "No sets played yet.";
    container.appendChild(empty);
    return container;
  }
  for (const s of sets) {
    container.appendChild(renderMeld(s));
  }
  return container;
}

function renderMeld(set) {
  const el = document.createElement("div");
  el.className = "meld";
  el.dataset.setId = set.id;
  for (let i = 0; i < set.cards.length; i++) {
    const c = set.cards[i];
    const opts = c.isWild
      ? { wild: true, represents: { rank: c.representsRank, suit: set.type === "run" ? c.representsSuit : null } }
      : {};
    const cardEl = renderCard(c.card, opts);
    cardEl.dataset.positionIndex = String(i);
    el.appendChild(cardEl);
  }
  el.addEventListener("scroll", () => meldOverflowUpdate(el), { passive: true });
  return el;
}

function renderMiddle() {
  $("draw-count").textContent = String(state.deck.length);
  // Highlight piles by phase.
  const drawBtn = $("draw-pile");
  const discardBtn = $("discard-pile");
  drawBtn.classList.toggle("is-active", state.phase === "mustDraw");
  // Discard pile: active either when draw target (has top) or when canAct + 1 card selected.
  const top = topOfDiscard(state);
  const discardHost = $("discard-host");
  discardHost.innerHTML = "";
  if (top) {
    discardHost.appendChild(renderCard(top, { wild: isWildcard(top, state.wildcardRank) }));
  } else {
    const empty = document.createElement("div");
    empty.className = "pile-card";
    empty.style.background = "rgba(255,255,255,0.04)";
    empty.style.border = "1px dashed rgba(255,255,255,0.2)";
    discardHost.appendChild(empty);
  }
  const discardActive =
    (state.phase === "mustDraw" && !!top) ||
    (state.phase === "canAct" && ui.selectedIds.size === 1);
  discardBtn.classList.toggle("is-active", discardActive);
  drawBtn.disabled = state.phase !== "mustDraw";
  discardBtn.disabled = !discardActive;
}

// In solo-vs-CPU we keep the human's hand on screen even when it's a CPU's
// turn (so the user can keep planning). Multiplayer always shows the active
// player (the pass screen gates everyone else).
function handViewerIdx() {
  // Online: always show MY hand, regardless of whose turn it is.
  if (online.isActive()) return online.mySeat();
  if (state && state.mode === "cpu") {
    const idx = state.players.findIndex(p => p.kind === "human");
    if (idx >= 0) return idx;
  }
  return state.currentPlayerIndex;
}

function renderHand() {
  const hand = $("hand");
  hand.innerHTML = "";
  const me = state.players[handViewerIdx()];
  if (!me) return;
  for (const c of me.hand) {
    const wild = isWildcard(c, state.wildcardRank);
    const el = renderCard(c, { wild });
    el.classList.add("in-hand");
    if (ui.selectedIds.has(c.id)) el.classList.add("selected");
    if (state.lastDrawnCardId === c.id) el.classList.add("just-drawn");
    hand.appendChild(el);
  }
  $("hand-hint").textContent = handHint();
  layoutHand();
}

// Lay out the hand in one of two modes:
//   fanned:   heavy fixed overlap (~55% of card_w hidden) + per-card rotation
//             pivoting below the row, so the cards look held in a real hand.
//   spread:   minimal gap; overlap only as much as needed to fit the width.
// Per-card rotation is written into `--card-rot`; container overlap into
// `--hand-overlap`. Cards are centered horizontally via `justify-content` in
// CSS, so we don't need to compute padding/margins to balance them.
function layoutHand() {
  const hand = $("hand");
  if (!hand) return;
  const cards = hand.querySelectorAll(".card");
  const n = cards.length;
  hand.classList.toggle("fanned", !!ui.handFanned);
  // Clear stale rotations whenever we re-layout — we may have just toggled
  // fan off, or the card count may have shrunk.
  cards.forEach(c => c.style.removeProperty("--card-rot"));

  if (n === 0) {
    hand.style.setProperty("--hand-overlap", "6px");
    return;
  }

  const cardW = parseFloat(getComputedStyle(cards[0]).width) || 58;

  // Available width is shared by both layouts — at L/XL sizes on narrow
  // viewports, the fan's fixed 55% overlap can push the hand past the screen
  // edge, so we tighten it to fit just like spread mode does.
  const cs = getComputedStyle(hand);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const available = Math.max(0, hand.clientWidth - padX);

  if (ui.handFanned) {
    // The fan rotates each card around a pivot 220% below it (see
    // transform-origin in .hand.fanned > .card). That pivot is far enough
    // away that the edge cards' top corners swing well past the card's own
    // box — at XL on a narrow phone the leftmost corner can land off-screen.
    // Account for that swing here: compute how much extra horizontal space
    // the rotation needs at each end, then fit the row to (available - swing).
    const cardH = parseFloat(getComputedStyle(cards[0]).height) || (cardW * 1.55);
    const pivotY = 2.2 * cardH;
    const swingFor = (deg) => {
      const r = (deg * Math.PI) / 180;
      return (cardW / 2) * (1 - Math.cos(r)) + pivotY * Math.sin(r);
    };

    // Default tilt: ≤4° per card, capped so 8+ cards don't fan into a half-circle.
    let stepDeg = n > 1 ? Math.min(4, 22 / (n - 1)) : 0;
    let edgeDeg = stepDeg * (n - 1) / 2;

    // Heavy overlap so cards stack like in a real hand. Show ~45% of each
    // card's left edge by default; tighten further if the row would overflow.
    const minStep = Math.max(1, Math.round(cardW * 0.08));
    let overlap = -Math.round(cardW * 0.55);

    if (n > 1 && available > 0) {
      const swing = swingFor(edgeDeg);
      const budget = Math.max(0, available - 2 * swing);
      const fannedWidth = cardW + (n - 1) * (cardW + overlap);
      if (fannedWidth > budget) {
        const step = (budget - cardW) / (n - 1);
        if (step >= minStep) {
          overlap = step - cardW;
        } else {
          // Min overlap still doesn't leave room for the full tilt — pull
          // the rotation in so the corners don't shoot off-screen. The
          // resulting fan is flatter but still visibly fanned when possible.
          overlap = minStep - cardW;
          const tightWidth = cardW + (n - 1) * (cardW + overlap);
          const swingBudget = Math.max(0, (available - tightWidth) / 2);
          if (swingBudget <= 0 || pivotY <= 0) {
            edgeDeg = 0;
          } else {
            const r = Math.asin(Math.min(1, swingBudget / pivotY));
            edgeDeg = Math.min(edgeDeg, (r * 180) / Math.PI);
          }
          stepDeg = n > 1 ? (2 * edgeDeg) / (n - 1) : 0;
        }
      }
    }

    hand.style.setProperty("--hand-overlap", `${overlap}px`);
    const startDeg = -edgeDeg;
    cards.forEach((c, i) => {
      const rot = startDeg + stepDeg * i;
      c.style.setProperty("--card-rot", `${rot.toFixed(2)}deg`);
    });
    return;
  }

  // Spread mode — pack to width only if natural layout doesn't fit.
  const naturalGap = 6;
  const naturalWidth = n * cardW + (n - 1) * naturalGap;
  if (n === 1 || naturalWidth <= available) {
    hand.style.setProperty("--hand-overlap", `${naturalGap}px`);
    return;
  }
  // cardW + (n - 1) * step = available  →  step = (available - cardW) / (n - 1)
  const step = (available - cardW) / (n - 1);
  hand.style.setProperty("--hand-overlap", `${step - cardW}px`);
}

function syncFanToggleLabel() {
  const btn = $("fan-toggle-btn");
  if (!btn) return;
  btn.textContent = ui.handFanned ? "Fan: On" : "Fan: Off";
  btn.setAttribute("aria-pressed", String(!!ui.handFanned));
}

function handHint() {
  if (state.phase === "mustDraw") return "Draw a card to start your turn — tap the deck or the discard pile.";
  if (state.phase === "canAct") {
    if (ui.selectedIds.size === 0) return "Select cards to play a set, or pick one and tap the discard pile to end your turn.";
    if (ui.selectedIds.size === 1) return "Tap the discard pile to discard this card.";
    return "Tap Play set or Add to set.";
  }
  return "";
}

function renderActions() {
  const canPlay = ui.selectedIds.size >= 3 && state.phase === "canAct";
  const me = currentPlayer(state);
  const wildsOnTable = state.table.some(s => s.cards.some(c => c.isWild));
  const canAdd = state.phase === "canAct" && me.hasOpened && ui.selectedIds.size >= 1 && state.table.length > 0;
  const canSwap = state.phase === "canAct" && me.hasOpened && wildsOnTable;

  $("play-set-btn").disabled = !canPlay;
  // Add-to-set and swap-wild aren't covered by the tutorial script; lock them
  // off so a curious tap doesn't derail the scripted plays.
  const inTutorial = tutorial.isTutorialActive();
  $("add-set-btn").disabled = !canAdd || inTutorial;
  $("swap-btn").disabled = !canSwap || inTutorial;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));
}

// ---------- User interactions ----------
function exitToStart() {
  // Online sessions can't be "saved" locally — leaving the screen leaves the
  // room (stops polling, frees the seat in the lobby).
  if (online.isInSession()) {
    online.leave();
    state = null;
    ui.selectedIds.clear();
    selectMode("online");
    showScreen("screen-start");
    return;
  }
  if (state) persist();
  // If the user bails mid-tutorial via Save & exit, tear down the coach so
  // it doesn't linger on the start screen.
  tutorial.endTutorial();
  // Land the start screen on the mode we just left so its resume banner shows
  // the match we just saved (selectMode also re-renders the banner).
  const leftMode = state && state.mode;
  state = null;
  ui.selectedIds.clear();
  if (leftMode) selectMode(leftMode); else renderResumeBanner();
  showScreen("screen-start");
}

// Mobile top-bar hamburger. The trigger button and dropdown live inside the
// top-bar; on screens >600px the trigger is hidden by CSS and the inline
// ?/feedback/exit pills are shown instead.
const MENU_ACTIONS = { rules: openRules, feedback: openFeedback, exit: exitToStart };
function closeAllTopBarMenus() {
  document.querySelectorAll(".top-bar-menu-list").forEach(list => {
    list.classList.add("hidden");
    const id = list.id;
    const trigger = document.querySelector(`[aria-controls="${id}"]`);
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  });
}
function wireTopBarMenu(btnId, listId) {
  const btn = $(btnId);
  const list = $(listId);
  if (!btn || !list) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = !list.classList.contains("hidden");
    closeAllTopBarMenus();
    if (!wasOpen) {
      list.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
    }
  });
  list.addEventListener("click", (e) => {
    const item = e.target.closest(".menu-item");
    if (!item) return;
    const action = MENU_ACTIONS[item.dataset.action];
    closeAllTopBarMenus();
    if (action) action();
  });
}
document.addEventListener("click", (e) => {
  // Card size segs (start screen + both hamburger menus) all route through
  // setCardSize so they stay in sync.
  const sizeBtn = e.target.closest("#card-size-seg .seg-btn, [data-menu-card-size] .seg-btn");
  if (sizeBtn) {
    setCardSize(sizeBtn.dataset.size);
    return;
  }
  if (e.target.closest(".top-bar-menu")) return;
  closeAllTopBarMenus();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllTopBarMenus();
});

function wireUp() {
  $("play-exit-btn").addEventListener("click", exitToStart);
  $("scoring-exit-btn").addEventListener("click", exitToStart);
  $("play-rules-btn").addEventListener("click", openRules);
  $("scoring-rules-btn").addEventListener("click", openRules);
  $("play-feedback-btn").addEventListener("click", openFeedback);
  $("scoring-feedback-btn").addEventListener("click", openFeedback);
  wireTopBarMenu("play-menu-btn", "play-menu-list");
  wireTopBarMenu("scoring-menu-btn", "scoring-menu-list");
  wireInstallLink();

  // Card selection (delegated)
  $("hand").addEventListener("click", (e) => {
    if (state.phase !== "canAct") return;
    const card = e.target.closest(".card.in-hand");
    if (!card) return;
    const id = card.dataset.cardId;
    // During specific tutorial steps, only the highlighted cards are tappable —
    // keeps the user on the scripted path even if they reach for a stray card.
    const allowed = tutorial.selectableCardIds();
    if (allowed && !allowed.includes(id)) return;
    if (ui.selectedIds.has(id)) ui.selectedIds.delete(id);
    else ui.selectedIds.add(id);
    renderAll();
    tutorial.notify("selectionChange", { selectedIds: ui.selectedIds });
  });

  // Drag reorder + drop onto discard/meld/wildcard targets.
  makeHandReorderable(
    $("hand"),
    (fromIndex, toIndex) => {
      const me = currentPlayer(state);
      const [moved] = me.hand.splice(fromIndex, 1);
      me.hand.splice(toIndex, 0, moved);
      renderHand();
    },
    {
      resolveDropTarget: resolveDropTarget,
      onDropOnTarget: handleDropOnTarget,
      onPlaceholderMove: layoutHand,
    },
  );

  // Draw pile / discard pile
  $("draw-pile").addEventListener("click", () => {
    if (state.phase !== "mustDraw") return;
    const r = drawFromDeck(state);
    if (!r.ok) toast(r.reason);
    if (r.ok) online.record({ type: "drawDeck" });
    persist();
    renderAll();
    if (r.ok) tutorial.notify("drawDeck");
  });
  $("discard-pile").addEventListener("click", () => {
    if (state.phase === "mustDraw") {
      const r = drawFromDiscard(state);
      if (!r.ok) toast(r.reason);
      if (r.ok) online.record({ type: "drawDiscard" });
      persist();
      renderAll();
      return;
    }
    if (state.phase === "canAct" && ui.selectedIds.size === 1) {
      const id = [...ui.selectedIds][0];
      const r = discard(state, id);
      if (!r.ok) { toast(r.reason); return; }
      online.record({ type: "discard", cardId: id });
      ui.selectedIds.clear();
      afterDiscard(r);
    }
  });

  // Sort button
  $("sort-btn").addEventListener("click", () => {
    const me = currentPlayer(state);
    me.hand = [...me.hand].sort((a, b) => compareForSort(a, b, state.wildcardRank));
    renderHand();
  });

  // Fan toggle — heavy overlap + per-card tilt vs spread layout.
  const fanBtn = $("fan-toggle-btn");
  if (fanBtn) {
    syncFanToggleLabel();
    fanBtn.addEventListener("click", () => {
      ui.handFanned = !ui.handFanned;
      savePrefs({ ...loadPrefs(), handFanned: ui.handFanned });
      syncFanToggleLabel();
      layoutHand();
    });
  }

  // Play set
  $("play-set-btn").addEventListener("click", () => {
    const me = currentPlayer(state);
    const cards = [...ui.selectedIds].map(id => me.hand.find(c => c.id === id)).filter(Boolean);
    const v = validateNewSet(cards, state.wildcardRank);
    if (!v.ok) { toast(v.reason); return; }
    if (v.type === "number") {
      doPlace({ type: "number", rank: v.rank, cards: v.cards });
    } else {
      const arrangements = v.arrangements;
      if (arrangements.length === 1) {
        doPlace({ type: "run", ...arrangements[0] });
      } else {
        chooseArrangement(arrangements, (chosen) => doPlace({ type: "run", ...chosen }));
      }
    }
  });

  // Add to set
  $("add-set-btn").addEventListener("click", openAddToSetModal);

  // Swap wild
  $("swap-btn").addEventListener("click", openSwapModal);

  // Round end / match end buttons
  $("continue-btn").addEventListener("click", () => {
    // Online: only the host advances the round / ends the match; everyone else
    // waits for the synced state to arrive via polling.
    if (online.isInSession()) { online.advance(); return; }
    // Scoring mode has its own flow.
    if (state && state.mode === "scoring") {
      if (isScoringMatchOver(state)) { goMatchEnd(); return; }
      advanceScoringRound(state);
      persist();
      goScoringRoundScreen();
      return;
    }
    if (isMatchOver(state)) {
      goMatchEnd();
    } else {
      advanceToNextRound(state);
      persist();
      routeTurnStart();
    }
  });
  $("new-match-btn").addEventListener("click", () => {
    if (online.isInSession()) {
      online.leave();
      state = null;
      ui.selectedIds.clear();
      selectMode("online");
      showScreen("screen-start");
      return;
    }
    const finishedMode = state && state.mode;
    discardSave(finishedMode);
    state = null;
    ui.selectedIds.clear();
    if (finishedMode) selectMode(finishedMode); else renderResumeBanner();
    showScreen("screen-start");
  });

  // Modal closers
  $("modal-pick-cancel").addEventListener("click", () => $("modal-pick-set").classList.add("hidden"));
  $("modal-swap-cancel").addEventListener("click", () => $("modal-swap").classList.add("hidden"));

  // Scoring submit
  $("sc-submit").addEventListener("click", onScoringSubmit);

  // Resume banner
  $("resume-go").addEventListener("click", resumeFromSave);
  $("resume-discard").addEventListener("click", () => {
    discardSave(ui.mode);
    renderResumeBanner();
  });

  // Profile screen
  $("profile-back-btn").addEventListener("click", () => {
    renderResumeBanner();
    showScreen("screen-start");
  });
  $("profile-picker").addEventListener("change", () => {
    // Re-default mode to the freshly-picked player's most-recent mode.
    const profiles = loadProfiles();
    const p = profiles.players[$("profile-picker").value];
    const firstHist = p && p.matchHistory && p.matchHistory[0];
    profileSelectedMode = firstHist && ALL_MODES.includes(firstHist.mode) ? firstHist.mode : "multiplayer";
    paintProfileModeSeg();
    renderProfileBody($("profile-picker").value, profileSelectedMode);
  });
  $("profile-mode-seg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    profileSelectedMode = btn.dataset.mode;
    paintProfileModeSeg();
    renderProfileBody($("profile-picker").value, profileSelectedMode);
  });
}

function doPlace(arrangement) {
  const r = placeNewSet(state, arrangement);
  if (!r.ok) { toast(r.reason); return; }
  online.record({ type: "play", arrangement });
  ui.selectedIds.clear();
  persist();
  renderAll();
  tutorial.notify("playSet");
}

function chooseArrangement(arrangements, onPick) {
  const modal = $("modal-wild-choice");
  $("modal-wild-title").textContent = "Use wildcard as…";
  $("modal-wild-body").textContent = "More than one placement is valid. Pick the one you want.";
  const acts = $("modal-wild-actions");
  acts.innerHTML = "";
  for (const a of arrangements) {
    const b = document.createElement("button");
    b.className = "pill primary";
    b.textContent = describeRunArrangement(a);
    b.addEventListener("click", () => {
      modal.classList.add("hidden");
      onPick(a);
    });
    acts.appendChild(b);
  }
  const cancel = document.createElement("button");
  cancel.className = "pill ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => modal.classList.add("hidden"));
  acts.appendChild(cancel);
  modal.classList.remove("hidden");
}

function chooseAdditionArrangement(arrangements, set, onPick) {
  const modal = $("modal-wild-choice");
  $("modal-wild-title").textContent = "Where do these cards go?";
  $("modal-wild-body").textContent = "More than one placement is valid for this run.";
  const acts = $("modal-wild-actions");
  acts.innerHTML = "";
  for (const a of arrangements) {
    const b = document.createElement("button");
    b.className = "pill primary";
    b.textContent = describeAddition(a, set);
    b.addEventListener("click", () => {
      modal.classList.add("hidden");
      onPick(a);
    });
    acts.appendChild(b);
  }
  const cancel = document.createElement("button");
  cancel.className = "pill ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => modal.classList.add("hidden"));
  acts.appendChild(cancel);
  modal.classList.remove("hidden");
}

// ---------- Drag-and-drop drop targets ----------
// Called by dragdrop.js on every pointermove during an active drag, and on
// release. Walks the elements under the cursor and returns the highest-
// priority legal target: discard > swap wildcard > add to set. Returns null
// if the card isn't currently playable to anything under the pointer.
function resolveDropTarget(clientX, clientY, cardEl) {
  if (!state) return null;
  if (state.phase !== "canAct" && state.phase !== "mustDiscard") return null;
  const me = currentPlayer(state);
  if (!me) return null;
  const card = me.hand.find(c => c.id === cardEl.dataset.cardId);
  if (!card) return null;

  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    if (!el || el === cardEl) continue;
    // 1) Discard pile.
    if (el.closest && el.closest("#discard-pile")) {
      return { kind: "discard", el: document.getElementById("discard-pile"), data: { cardId: card.id } };
    }
    // 2) Wildcard inside a meld → swap, only if natural is legal.
    const tableCard = el.closest && el.closest("#all-melds .meld .card");
    if (tableCard && tableCard.classList.contains("is-wild")) {
      const meld = tableCard.closest(".meld");
      if (!meld) continue;
      const setId = meld.dataset.setId;
      const positionIndex = Number(tableCard.dataset.positionIndex);
      const set = state.table.find(s => s.id === setId);
      if (!set || !me.hasOpened) continue;
      const v = validateSwap(set, positionIndex, card, state.wildcardRank);
      if (v.ok) {
        return { kind: "swap", el: tableCard, data: { setId, positionIndex, naturalCardId: card.id } };
      }
    }
    // 3) Meld body → add-to-set, only if validateAddition passes.
    const meld = el.closest && el.closest("#all-melds .meld");
    if (meld && me.hasOpened) {
      const setId = meld.dataset.setId;
      const set = state.table.find(s => s.id === setId);
      if (!set) continue;
      const v = validateAddition(set, [card], state.wildcardRank);
      if (v.ok) {
        return { kind: "add", el: meld, data: { setId, cardId: card.id, validation: v } };
      }
    }
  }
  return null;
}

function handleDropOnTarget(target, _cardEl) {
  if (!state) return;
  if (target.kind === "discard") {
    // Must keep at least 1 card to discard; engine will refuse otherwise.
    const r = discard(state, target.data.cardId);
    if (!r.ok) { toast(r.reason); return; }
    online.record({ type: "discard", cardId: target.data.cardId });
    ui.selectedIds.clear();
    afterDiscard(r);
    return;
  }
  if (target.kind === "swap") {
    const r = swapWildcard(state, target.data.setId, target.data.positionIndex, target.data.naturalCardId);
    if (!r.ok) { toast(r.reason); return; }
    online.record({ type: "swap", setId: target.data.setId, positionIndex: target.data.positionIndex, naturalCardId: target.data.naturalCardId });
    ui.selectedIds.clear();
    persist();
    renderAll();
    return;
  }
  if (target.kind === "add") {
    const set = state.table.find(s => s.id === target.data.setId);
    if (!set) return;
    const v = target.data.validation;
    if (set.type === "number") {
      finalizeAddition(set, v.arrangement);
    } else if (v.arrangements && v.arrangements.length === 1) {
      finalizeAddition(set, v.arrangements[0]);
    } else if (v.arrangements && v.arrangements.length > 1) {
      chooseAdditionArrangement(v.arrangements, set, chosen => finalizeAddition(set, chosen));
    }
    return;
  }
}

function openAddToSetModal() {
  const me = currentPlayer(state);
  if (!me.hasOpened) { toast("Open with your own set first."); return; }
  const cards = [...ui.selectedIds].map(id => me.hand.find(c => c.id === id)).filter(Boolean);
  if (!cards.length) { toast("Select at least one card to add."); return; }
  // Compute valid sets for these cards.
  const options = [];
  for (const s of state.table) {
    const v = validateAddition(s, cards, state.wildcardRank);
    if (v.ok) options.push({ set: s, validation: v });
  }
  if (!options.length) {
    toast("Those cards don't fit any set on the table.");
    return;
  }
  const modal = $("modal-pick-set");
  const list = $("set-picker");
  list.innerHTML = "";
  for (const opt of options) {
    const row = document.createElement("div");
    row.className = "set-row";
    const info = document.createElement("div");
    info.className = "set-row-info";
    const owner = state.players[opt.set.ownerIndex];
    const label = opt.set.type === "number"
      ? `${owner.name}'s ${opt.set.rank}s`
      : `${owner.name}'s ${SUIT_GLYPH[opt.set.suit]} run`;
    info.innerHTML = `<strong>${escapeHTML(label)}</strong><span>${opt.set.cards.length} cards</span>`;
    row.appendChild(info);
    const cardsEl = document.createElement("div");
    cardsEl.className = "set-row-cards";
    for (const c of opt.set.cards) {
      const opts = c.isWild ? { wild: true, represents: { rank: c.representsRank, suit: opt.set.type === "run" ? c.representsSuit : null } } : {};
      cardsEl.appendChild(renderCard(c.card, opts));
    }
    row.appendChild(cardsEl);
    const commit = () => {
      modal.classList.add("hidden");
      const v = opt.validation;
      if (opt.set.type === "number") {
        finalizeAddition(opt.set, v.arrangement);
      } else {
        if (v.arrangements.length === 1) finalizeAddition(opt.set, v.arrangements[0]);
        else chooseAdditionArrangement(v.arrangements, opt.set, (chosen) => finalizeAddition(opt.set, chosen));
      }
    };
    const btn = document.createElement("button");
    btn.className = "pill primary";
    btn.textContent = "Add";
    btn.addEventListener("click", (ev) => { ev.stopPropagation(); commit(); });
    row.appendChild(btn);
    row.addEventListener("click", commit);
    list.appendChild(row);
  }
  modal.classList.remove("hidden");
}

function finalizeAddition(set, arrangement) {
  const r = addToSet(state, set.id, arrangement);
  if (!r.ok) { toast(r.reason); return; }
  online.record({ type: "add", setId: set.id, arrangement });
  ui.selectedIds.clear();
  persist();
  renderAll();
}

function openSwapModal() {
  const me = currentPlayer(state);
  if (!me.hasOpened) { toast("Open with your own set first."); return; }
  const modal = $("modal-swap");
  const list = $("swap-list");
  list.innerHTML = "";
  let any = false;
  for (const s of state.table) {
    for (let i = 0; i < s.cards.length; i++) {
      const c = s.cards[i];
      if (!c.isWild) continue;
      // Determine required natural card.
      const needRank = c.representsRank;
      const needSuit = s.type === "run" ? c.representsSuit : null;
      const naturalCard = me.hand.find(h => {
        if (isWildcard(h, state.wildcardRank)) return false;
        if (h.rank !== needRank) return false;
        if (needSuit && h.suit !== needSuit) return false;
        if (!needSuit) {
          const existingSuits = new Set(s.cards.filter((cc, k) => k !== i && !cc.isWild).map(cc => cc.card.suit));
          if (existingSuits.has(h.suit)) return false;
        }
        return true;
      });
      const row = document.createElement("div");
      row.className = "swap-row";
      const info = document.createElement("div");
      info.className = "set-row-info";
      const owner = state.players[s.ownerIndex];
      const label = s.type === "number"
        ? `${owner.name}'s ${s.rank}s`
        : `${owner.name}'s ${SUIT_GLYPH[s.suit]} run`;
      const need = s.type === "run"
        ? `Needs ${needRank} of ${SUIT_GLYPH[needSuit]}`
        : `Needs a ${needRank} of a missing suit`;
      info.innerHTML = `<strong>${escapeHTML(label)}</strong><span>${escapeHTML(need)}</span>`;
      row.appendChild(info);
      const preview = document.createElement("div");
      preview.className = "set-row-cards";
      const wildPreview = renderCard(c.card, { wild: true, represents: { rank: needRank, suit: needSuit } });
      preview.appendChild(wildPreview);
      row.appendChild(preview);

      const btn = document.createElement("button");
      btn.className = "pill primary";
      btn.textContent = naturalCard ? "Swap" : "Can't swap";
      btn.disabled = !naturalCard;
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!naturalCard) return;
        modal.classList.add("hidden");
        const r = swapWildcard(state, s.id, i, naturalCard.id);
        if (!r.ok) { toast(r.reason); return; }
        online.record({ type: "swap", setId: s.id, positionIndex: i, naturalCardId: naturalCard.id });
        ui.selectedIds.clear();
        persist();
        renderAll();
      });
      row.appendChild(btn);
      list.appendChild(row);
      any = true;
    }
  }
  if (!any) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No wildcards on the table to swap.";
    list.appendChild(empty);
  }
  modal.classList.remove("hidden");
}

function afterDiscard(result) {
  persist();
  tutorial.notify("discard", { wonRound: !!result.wonRound });
  if (result.wonRound) {
    // Online: commit the round-over state so everyone sees the win, then the
    // commit's local route lands us on the round-end screen.
    if (online.isActive()) { online.commitTurn(); return; }
    goRoundEnd();
    return;
  }
  // Auto-detect a deadlocked round (no runs, all number sets capped, and no
  // hand can form a new set). Cheaper than scanning every action — discards
  // are the only state change that can lock down the rank-set count.
  if (isNoWayOut(state)) {
    finalizeNoWayOut(state);
    persist();
    state.noWayOutTriggered = true;
    if (online.isActive()) { online.commitTurn(); return; }
    goRoundEnd();
    return;
  }
  // Online: hand the just-finished turn to the server; the poll/route flow
  // takes the next player from here.
  if (online.isActive()) { online.commitTurn(); return; }
  // Refresh the play screen so the just-discarded card disappears from the
  // hand and the new discard-pile top renders, before either kicking off a
  // CPU turn or transitioning to the pass screen. handViewerIdx keeps the
  // human's hand visible in solo mode regardless of whose turn comes next.
  renderAll();
  routeTurnStart();
}

// ---------- Scoring-mode screen ----------
function goScoringRoundScreen() {
  showScreen("screen-scoring");
  $("sc-round").textContent = ROUND_NAMES[state.round - 1] || state.round;
  $("sc-wild").textContent = state.wildcardRank;
  $("sc-dealer").textContent = state.players[state.dealerIndex].name;

  // UI selection state local to this screen.
  const sel = { winnerIdx: null, scores: state.players.map(() => "") };

  const rows = $("sc-rows");
  rows.innerHTML = "";
  state.players.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "sc-row";
    row.dataset.idx = String(i);

    const name = document.createElement("div");
    name.className = "sc-name";
    name.textContent = p.name + (i === state.dealerIndex ? " (D)" : "");
    row.appendChild(name);

    const winBtn = document.createElement("button");
    winBtn.type = "button";
    winBtn.className = "sc-winner-btn";
    winBtn.textContent = "Winner";
    winBtn.addEventListener("click", () => {
      sel.winnerIdx = sel.winnerIdx === i ? null : i;
      if (sel.winnerIdx === i) sel.scores[i] = "0";
      paint();
    });
    row.appendChild(winBtn);

    const inp = document.createElement("input");
    inp.type = "number";
    inp.inputMode = "numeric";
    inp.min = "0";
    inp.max = "999";
    inp.step = "1";
    inp.className = "sc-input";
    inp.placeholder = "Hand pts";
    inp.value = sel.scores[i];
    inp.addEventListener("input", () => { sel.scores[i] = inp.value; });
    row.appendChild(inp);

    function paint() {
      [...rows.children].forEach(r => {
        const idx = Number(r.dataset.idx);
        r.classList.toggle("is-winner", sel.winnerIdx === idx);
        const wb = r.querySelector(".sc-winner-btn");
        wb.classList.toggle("is-on", sel.winnerIdx === idx);
        const ip = r.querySelector(".sc-input");
        if (sel.winnerIdx === idx) { ip.value = "0"; ip.disabled = true; sel.scores[idx] = "0"; }
        else { ip.disabled = false; if (ip.value === "0" && sel.scores[idx] === "0") { ip.value = ""; sel.scores[idx] = ""; } }
      });
    }
    rows.appendChild(row);
  });

  // Stash for the submit handler — closure capture.
  $("sc-submit")._sel = sel;

  renderScoringHistory();
}

function renderScoringHistory() {
  const host = $("sc-history");
  if (!host) return;
  const history = Array.isArray(state.roundHistory) ? state.roundHistory : [];
  if (!history.length) { host.innerHTML = ""; return; }
  const head = `<tr><th>R</th>${state.players.map(p => `<th>${escapeHTML(p.name)}</th>`).join("")}</tr>`;
  const body = history.map(h => {
    const cells = h.cumulative.map((c, i) =>
      `<td class="${i === h.winnerIdx ? "winner" : ""}">${c}</td>`).join("");
    return `<tr><td class="r-col">${h.round}</td>${cells}</tr>`;
  }).join("");
  host.innerHTML = `<h3 class="sc-history-title">Running scores</h3>
    <table class="sc-history-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function onScoringSubmit() {
  const sel = $("sc-submit")._sel;
  if (!sel) return;
  if (sel.winnerIdx == null) { toast("Pick a winner."); return; }
  for (let i = 0; i < sel.scores.length; i++) {
    if (i === sel.winnerIdx) continue;
    const v = (sel.scores[i] ?? "").toString().trim();
    if (v === "") { toast(`Enter a score for ${state.players[i].name}.`); return; }
  }
  const scores = sel.scores.map(s => Number.parseInt(s, 10) || 0);
  const r = submitScoringRound(state, sel.winnerIdx, scores);
  if (!r.ok) { toast(r.reason); return; }
  persist();
  goRoundEnd();
}

// ---------- Round / Match end ----------
function goRoundEnd() {
  showScreen("screen-round-end");
  const winnerIdx = state.roundWinner;
  const noWayOut = state.roundHistory[state.roundHistory.length - 1] && state.roundHistory[state.roundHistory.length - 1].noWayOut;
  if (noWayOut) {
    $("round-end-title").textContent = `NO WAY OUT — round ${ROUND_NAMES[state.round - 1] || state.round}`;
    $("round-end-winner").innerHTML = `Round ended in deadlock — no winner. Everyone scores their remaining hand.`;
  } else {
    $("round-end-title").textContent = `Round ${ROUND_NAMES[state.round - 1] || state.round} complete`;
    $("round-end-winner").innerHTML = `<strong>${escapeHTML(state.players[winnerIdx].name)}</strong> took the round.`;
  }
  const tbody = $("round-end-rows");
  tbody.innerHTML = "";
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    const tr = document.createElement("tr");
    if (!noWayOut && i === winnerIdx) tr.className = "winner-row";
    tr.innerHTML = `<td>${escapeHTML(p.name)}</td><td>${state.perRoundScores[i]}</td><td><strong>${p.score}</strong></td>`;
    tbody.appendChild(tr);
  }
  $("continue-btn").textContent = state.round >= TOTAL_ROUNDS ? "See match result" : `Continue to round ${ROUND_NAMES[state.round] || state.round + 1}`;
}

function goMatchEnd() {
  showScreen("screen-match-end");
  const winnerIdx = matchWinnerIndex(state);
  $("match-winner-name").textContent = state.players[winnerIdx].name;
  const tbody = $("match-end-rows");
  tbody.innerHTML = "";
  const sorted = state.players.map((p, i) => ({ p, i })).sort((a, b) => a.p.score - b.p.score);
  for (const { p, i } of sorted) {
    const tr = document.createElement("tr");
    if (i === winnerIdx) tr.className = "winner-row";
    tr.innerHTML = `<td>${escapeHTML(p.name)}</td><td><strong>${p.score}</strong></td>`;
    tbody.appendChild(tr);
  }
  renderMatchEndHistory();
  // Online v1 doesn't fold results into local profiles (each device would
  // otherwise record every opponent under its own local store). Profiles stay
  // a local-play feature for now.
  if (online.isInSession()) {
    const host = $("match-end-rewards");
    if (host) host.innerHTML = "";
  } else {
    recordAndRenderRewards();
  }
  buildConfetti();
  if (!online.isInSession()) discardSave();
}

// Fold the just-finished match into the player profiles store and render the
// per-player "Rewards earned" section on the match-end screen. Persists nothing
// if the storage layer is unavailable (profiles.js is graceful).
function recordAndRenderRewards() {
  const host = $("match-end-rewards");
  if (!host) return;
  host.innerHTML = "";
  if (!state) return;
  const profiles = loadProfiles();
  const summary = buildMatchSummary(state);
  const { newUnlocks, progressUnlocks, progressGains } = recordMatch(profiles, summary);
  saveProfiles(profiles);

  // Union of every player who has anything new to celebrate.
  const allIdxs = new Set([
    ...Object.keys(newUnlocks).map(Number),
    ...Object.keys(progressUnlocks).map(Number),
    ...Object.keys(progressGains).map(Number),
  ]);
  if (!allIdxs.size) return;

  const title = document.createElement("h3");
  title.className = "sc-history-title";
  title.textContent = "Rewards earned";
  host.appendChild(title);

  // Look up the player's POST-record profile so progress bars in the rewards
  // block reflect the just-folded match.
  for (const idx of allIdxs) {
    const p = state.players[idx];
    const block = document.createElement("div");
    block.className = "rewards-block";
    const head = document.createElement("div");
    head.className = "rewards-name";
    head.textContent = p.name;
    block.appendChild(head);

    // 1) one-shot unlocks earned this match
    const oneShots = newUnlocks[idx] || [];
    if (oneShots.length) {
      const grid = document.createElement("div");
      grid.className = "rewards-grid";
      for (const id of oneShots) {
        const a = achievementById(id);
        if (!a) continue;
        grid.appendChild(renderAchievementCard(a, true));
      }
      block.appendChild(grid);
    }

    // 2) progress achievements that gained ground (including ones that just
    //    completed) — show the bar with the newly-earned items pulsing gold.
    const gains = progressGains[idx] || [];
    if (gains.length) {
      const prof = profiles.players[profileKeyFor(p.name)];
      const progress = readProgress(prof, summary.mode);
      const wrap = document.createElement("div");
      wrap.className = "rewards-progress-block";
      for (const gain of gains) {
        const def = PROGRESS_ACHIEVEMENTS.find(a => a.id === gain.id);
        if (!def) continue;
        const justEarned = new Set(gain.newItems || []);
        wrap.appendChild(renderProgressAchievementCard(def, progress[def.id], justEarned));
      }
      block.appendChild(wrap);
    }
    host.appendChild(block);
  }
}

function renderAchievementCard(a, unlocked) {
  const el = document.createElement("div");
  el.className = `achievement-card ${unlocked ? "is-unlocked" : "is-locked"}`;
  el.innerHTML = `
    <div class="achievement-icon" aria-hidden="true">${a.icon || "🏅"}</div>
    <div class="achievement-info">
      <div class="achievement-name">${escapeHTML(a.name)}</div>
      <div class="achievement-desc">${escapeHTML(a.description)}</div>
    </div>
  `;
  return el;
}

// Render a progress achievement: name + description + bar growing to target,
// plus per-item chips for the multi-item ones (suits / ranks). `justEarned`
// is the set of items the just-finished match contributed, so they pulse.
function renderProgressAchievementCard(def, progress, justEarned = new Set()) {
  const value = Math.max(0, Math.min(def.target, progress.value || 0));
  const unlocked = value >= def.target;
  const pct = Math.round((value / def.target) * 100);
  const el = document.createElement("div");
  el.className = `achievement-card has-progress ${unlocked ? "is-unlocked" : ""}`;
  const info = document.createElement("div");
  info.className = "achievement-info";
  info.innerHTML = `
    <div class="achievement-name">${escapeHTML(def.name)}</div>
    <div class="achievement-desc">${escapeHTML(def.description)}</div>
    <div class="achievement-progress">
      <div class="achievement-progress-track"><div class="achievement-progress-fill" style="width:${pct}%"></div></div>
      <span class="achievement-progress-label">${value} / ${def.target}</span>
    </div>
  `;
  if (def.items) {
    const items = document.createElement("div");
    items.className = "achievement-items";
    for (const key of def.items.keys) {
      const chip = document.createElement("span");
      const on = !!(progress.items && progress.items[key]);
      const isJust = justEarned.has(key);
      let suitClass = "";
      if (def.id === "suit_sampler") suitClass = ` suit-${key.toLowerCase()}`;
      chip.className = `achievement-item${suitClass}${on ? " is-on" : ""}${isJust ? " is-just-earned" : ""}`;
      chip.textContent = def.items.labelFor(key);
      chip.title = def.items.titleFor(key);
      items.appendChild(chip);
    }
    info.appendChild(items);
  }
  el.innerHTML = `<div class="achievement-icon" aria-hidden="true">${def.icon || "🏅"}</div>`;
  el.appendChild(info);
  return el;
}

function renderMatchEndHistory() {
  const host = $("match-end-history");
  if (!host) return;
  const history = Array.isArray(state.roundHistory) ? state.roundHistory : [];
  if (!history.length) { host.innerHTML = ""; return; }
  const head = `<tr><th>R</th>${state.players.map(p => `<th>${escapeHTML(p.name)}</th>`).join("")}</tr>`;
  const body = history.map(h => {
    const label = ROUND_NAMES[h.round - 1] || h.round;
    const cells = h.scores.map((s, i) =>
      `<td class="${i === h.winnerIdx ? "winner" : ""}">${s}</td>`).join("");
    return `<tr><td class="r-col">${label}</td>${cells}</tr>`;
  }).join("");
  host.innerHTML = `<h3 class="sc-history-title">Round-by-round</h3>
    <table class="sc-history-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// ---------- Stats & achievements screen ----------
let profileSelectedMode = "multiplayer";

function openProfileScreen() {
  const profiles = loadProfiles();
  const picker = $("profile-picker");
  const known = listKnownPlayers(profiles);
  picker.innerHTML = "";
  for (const p of known) {
    const opt = document.createElement("option");
    opt.value = profileKeyFor(p.canonical);
    opt.textContent = p.canonical;
    picker.appendChild(opt);
  }
  showScreen("screen-profile");
  if (!known.length) {
    $("profile-empty").classList.remove("hidden");
    $("profile-body").classList.add("hidden");
    $("profile-mode-empty").classList.add("hidden");
    return;
  }
  $("profile-empty").classList.add("hidden");
  // Default mode = the most-recent mode this player has actually played.
  const p = profiles.players[picker.value];
  const firstHist = p && p.matchHistory && p.matchHistory[0];
  profileSelectedMode = firstHist && ALL_MODES.includes(firstHist.mode) ? firstHist.mode : "multiplayer";
  paintProfileModeSeg();
  renderProfileBody(picker.value, profileSelectedMode);
}

function paintProfileModeSeg() {
  const seg = $("profile-mode-seg");
  seg.querySelectorAll(".seg-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === profileSelectedMode);
  });
}

function renderProfileBody(playerKey, mode) {
  const profiles = loadProfiles();
  const p = profiles.players[playerKey];
  if (!p) return;

  const matches = p.matchHistory.filter(m => m.mode === mode);
  const body = $("profile-body");
  const empty = $("profile-mode-empty");
  if (!matches.length) {
    body.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  body.classList.remove("hidden");

  renderProfileStats(matches);
  renderProfileSparkline(matches);
  renderProfileRecent(matches);
  renderProfileAchievements(p, mode);
}

// All stats derived from matchHistory filtered to the selected mode.
function renderProfileStats(matches) {
  const host = $("profile-stats");
  host.innerHTML = "";
  const matchesPlayed = matches.length;
  const wins = matches.filter(m => m.position === 1).length;
  const scores = matches.map(m => m.finalScore);
  const total = scores.reduce((a, b) => a + b, 0);
  const winRate = matchesPlayed > 0 ? Math.round((wins / matchesPlayed) * 100) : 0;
  const avg = matchesPlayed > 0 ? Math.round(total / matchesPlayed) : 0;
  const best = scores.length ? Math.min(...scores) : "—";
  const worst = scores.length ? Math.max(...scores) : "—";
  const roundsWon = matches.reduce((a, m) => a + (m.roundsWon || 0), 0);
  const tiles = [
    ["Matches", matchesPlayed],
    ["Wins", wins],
    ["Win rate", `${winRate}%`],
    ["Best", best],
    ["Worst", worst],
    ["Avg score", avg],
    ["Rounds won", roundsWon],
  ];
  for (const [label, value] of tiles) {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    tile.innerHTML = `<div class="stat-value">${escapeHTML(String(value))}</div><div class="stat-label">${escapeHTML(label)}</div>`;
    host.appendChild(tile);
  }
}

function renderProfileSparkline(matches) {
  const host = $("profile-sparkline");
  const section = $("profile-spark-section");
  // Last 20 matches in chronological order (matchHistory is newest-first).
  const series = matches.slice(0, 20).reverse().map(m => m.finalScore);
  if (series.length < 2) {
    host.innerHTML = `<p class="muted small-help">Play a few matches to see your trend.</p>`;
    section.classList.remove("hidden");
    return;
  }
  const W = 320, H = 80, PAD = 6;
  const min = Math.min(...series), max = Math.max(...series);
  const range = Math.max(1, max - min);
  const stepX = (W - PAD * 2) / (series.length - 1);
  const pts = series.map((v, i) => {
    const x = PAD + i * stepX;
    const y = PAD + (H - PAD * 2) * (1 - (v - min) / range);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  // Trend colour: compare first vs last (lower is better in Benny).
  const trend = series[series.length - 1] - series[0];
  const stroke = trend < -5 ? "#4caf6e" : trend > 5 ? "#d96a5b" : "#4a90e2";
  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="sparkline-svg" aria-label="Score over last ${series.length} matches">
      <polyline fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(" ")}" />
    </svg>
    <div class="sparkline-meta">
      <span>Latest: <strong>${series[series.length - 1]}</strong></span>
      <span>Best: <strong>${min}</strong></span>
    </div>
  `;
  section.classList.remove("hidden");
}

function renderProfileRecent(matches) {
  const tbody = $("profile-recent");
  tbody.innerHTML = "";
  const rows = matches.slice(0, 10);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">No matches yet.</td></tr>`;
    return;
  }
  for (const m of rows) {
    const tr = document.createElement("tr");
    const date = new Date(m.date);
    const dateStr = isNaN(date) ? "—" : date.toLocaleDateString();
    const modeLabel = MODE_LABELS[m.mode] || m.mode;
    const place = `${ordinal(m.position)} / ${m.totalPlayers}`;
    if (m.position === 1) tr.className = "winner-row";
    tr.innerHTML = `<td>${escapeHTML(dateStr)}</td><td>${escapeHTML(modeLabel)}</td><td>${m.finalScore}</td><td>${escapeHTML(place)}</td>`;
    tbody.appendChild(tr);
  }
}

function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function renderProfileAchievements(profile, mode) {
  const host = $("profile-achievements");
  host.innerHTML = "";
  // Progress achievements (suits / quads / long run) go first so the bars are
  // the first thing a returning player sees.
  const progress = readProgress(profile, mode);
  for (const def of PROGRESS_ACHIEVEMENTS) {
    if (!def.modes.includes(mode)) continue;
    host.appendChild(renderProgressAchievementCard(def, progress[def.id]));
  }
  // Then the one-shot achievements: unlocked first, then locked.
  const unlockedIds = new Set(profile.achievements
    .filter(a => a.matchContext && a.matchContext.mode === mode)
    .map(a => a.id));
  const eligible = ACHIEVEMENTS.filter(a => !a.modes || a.modes.includes(mode));
  const sorted = eligible.slice().sort((a, b) => {
    const au = unlockedIds.has(a.id) ? 0 : 1;
    const bu = unlockedIds.has(b.id) ? 0 : 1;
    return au - bu;
  });
  for (const a of sorted) {
    host.appendChild(renderAchievementCard(a, unlockedIds.has(a.id)));
  }
}

// ---------- Resume from saved match ----------
// The resume banner reflects the currently-selected mode's saved game (each
// mode has its own slot), so switching modes shows that mode's resumable match.
function renderResumeBanner() {
  const mode = ui.mode;
  const snapshot = storageLoad(mode);
  const banner = $("resume-banner");
  if (!snapshot || !snapshot.state || snapshot.state.mode !== mode) {
    if (snapshot) storageClear(mode); // stale / malformed slot
    banner.classList.add("hidden");
    return;
  }
  const s = snapshot.state;
  $("resume-banner-title").textContent = `Resume ${MODE_TITLES[mode]} match?`;
  $("resume-banner-detail").textContent = ` Round ${s.round || 1} of ${TOTAL_ROUNDS}`;
  banner.classList.remove("hidden");
}

function resumeFromSave() {
  const snapshot = storageLoad(ui.mode);
  if (!snapshot) return;
  state = hydrate(snapshot.state);
  if (!state) { discardSave(); renderResumeBanner(); return; }
  if (state.mode === "scoring") {
    if (state.phase === "roundOver") { goRoundEnd(); return; }
    if (state.phase === "matchOver") { goMatchEnd(); return; }
    goScoringRoundScreen();
    return;
  }
  // Multiplayer / CPU
  if (state.phase === "roundOver") { goRoundEnd(); return; }
  if (state.phase === "matchOver") { goMatchEnd(); return; }
  routeTurnStart();
}

function buildConfetti() {
  const wrap = $("confetti");
  wrap.innerHTML = "";
  const colors = ["#f5c451","#4a90e2","#c5283d","#1f5fa0","#ffffff"];
  const n = 60;
  for (let i = 0; i < n; i++) {
    const c = document.createElement("i");
    const left = (randomInt(1000) / 10).toFixed(1);
    const dur = (3 + randomInt(40) / 10).toFixed(1);
    const delay = (randomInt(30) / 10).toFixed(1);
    const dx = (randomInt(800) - 400) + "px";
    const color = colors[randomInt(colors.length)];
    c.style.cssText = `left:${left}%;background:${color};animation-duration:${dur}s;animation-delay:${delay}s;--dx:${dx};`;
    wrap.appendChild(c);
  }
}

// ---------- Card zoom (hover / long-press) ----------
function setupCardZoom() {
  const overlay = document.createElement("div");
  overlay.className = "card-zoom hidden";
  document.body.appendChild(overlay);

  let touchTimer = null;
  let touchOrigin = null;

  function zoomable(el) {
    return el && el.classList.contains("card")
      && !el.classList.contains("in-hand")
      && !el.classList.contains("back")
      && !el.classList.contains("drag-placeholder")
      && !el.closest(".discard-pile");
  }
  function show(card) {
    const clone = card.cloneNode(true);
    overlay.replaceChildren(clone);
    overlay.classList.remove("hidden");
  }
  function hide() {
    overlay.classList.add("hidden");
    overlay.replaceChildren();
  }

  // Desktop hover
  document.addEventListener("mouseover", (e) => {
    const card = e.target.closest(".card");
    if (!zoomable(card)) return;
    show(card);
  });
  document.addEventListener("mouseout", (e) => {
    const card = e.target.closest(".card");
    if (!zoomable(card)) return;
    if (e.relatedTarget && card.contains(e.relatedTarget)) return;
    hide();
  });

  // Mobile long-press (~450ms). Cancel on move/end/scroll.
  document.addEventListener("touchstart", (e) => {
    const card = e.target.closest(".card");
    if (!zoomable(card)) return;
    const t = e.touches[0];
    touchOrigin = { x: t.clientX, y: t.clientY };
    clearTimeout(touchTimer);
    touchTimer = setTimeout(() => show(card), 450);
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!touchOrigin) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - touchOrigin.x, t.clientY - touchOrigin.y) > 8) {
      clearTimeout(touchTimer);
      hide();
      touchOrigin = null;
    }
  }, { passive: true });
  const endTouch = () => {
    clearTimeout(touchTimer);
    hide();
    touchOrigin = null;
  };
  document.addEventListener("touchend", endTouch);
  document.addEventListener("touchcancel", endTouch);
}

// ---------- Welcome modal (first-launch name capture) ----------
function showWelcomeModalIfNeeded() {
  const prefs = loadPrefs();
  if (prefs.userName && prefs.userName.trim()) return;
  const modal = $("modal-welcome");
  const form = $("welcome-form");
  const input = $("welcome-name");
  modal.classList.remove("hidden");
  // Focus the input — autofocus attribute is unreliable when the element starts hidden.
  setTimeout(() => input.focus(), 0);
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = (input.value || "").trim();
    if (!name) { input.focus(); return; }
    savePrefs({ ...loadPrefs(), userName: name });
    applyUserName(name);
    modal.classList.add("hidden");
  };
}

// Update DEFAULT_NAMES[0] + any already-rendered inputs to use the new owner name.
function applyUserName(name) {
  DEFAULT_NAMES[0] = name;
  ui.solo.humanName = name;
  ui.playerNames[0] = name;
  // Re-paint name inputs that were built before onboarding completed.
  const soloInput = $("solo-name");
  if (soloInput) soloInput.value = name;
  if (typeof renderNameFields === "function") renderNameFields();
  if (typeof renderDealerSelect === "function") renderDealerSelect();
  if (typeof renderSoloDealer === "function") renderSoloDealer();
  if (typeof renderScoringNames === "function") renderScoringNames();
  if (typeof renderScoringDealer === "function") renderScoringDealer();
}

// Land on whichever mode has the most recently saved game, so returning
// players see their last match's resume prompt regardless of mode.
function selectMostRecentSavedMode() {
  const all = storageLoadAll();
  let best = null, bestAt = -1;
  for (const m of MATCH_MODES) {
    const snap = all[m];
    if (snap && (snap.savedAt || 0) > bestAt) { best = m; bestAt = snap.savedAt || 0; }
  }
  selectMode(best || ui.mode);
}

// ---------- Online multiplayer ----------
let onlineVisibility = "public";

// Hand main.js's state + renderers to the online controller. online.js never
// imports these directly because `state` and the DOM helpers are module-private.
function initOnline() {
  online.init({
    getState: () => state,
    setState: (s) => { state = s; },
    stepRemoteAction: stepCpuAnimated,
    renderAll,
    showScreen,
    toast,
    goRoundEnd,
    goMatchEnd,
    clearSelection: () => ui.selectedIds.clear(),
    beginSpectatorLock: () => document.body.classList.add("cpu-animating"),
    endSpectatorLock: () => document.body.classList.remove("cpu-animating"),
    onRoster: renderLobbyRoster,
  });

  net.initIdentity().then(() => refreshOnlineModeBlock());
  net.onAuth((user) => {
    if (user) { net.syncAuth(onlineDisplayName()).catch(() => {}); }
    refreshOnlineModeBlock();
  });
}

function onlineDisplayName() {
  const field = $("online-display-name");
  const typed = field && field.value.trim();
  if (typed) return typed;
  const u = net.currentUser();
  return (u && u.name) || (loadPrefs().userName || "").trim() || "Player";
}

function buildOnlineUI() {
  const signInBtn = $("online-signin-btn");
  if (!signInBtn) return; // markup not present
  signInBtn.addEventListener("click", () => net.signIn());
  $("online-signout-btn").addEventListener("click", () => net.signOut());

  const visSeg = $("online-visibility");
  visSeg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    visSeg.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    onlineVisibility = btn.dataset.vis;
    $("online-password-field").classList.toggle("hidden", onlineVisibility !== "private");
  });

  $("online-create-btn").addEventListener("click", onlineCreate);
  $("online-join-btn").addEventListener("click", onlineJoin);
  $("online-join-code").addEventListener("input", () => {
    // Show the password field once a code is typed (private tables need it).
    $("online-join-password").classList.toggle("hidden", $("online-join-code").value.trim().length === 0);
  });
  $("online-refresh-btn").addEventListener("click", () => loadOnlineRoomList());

  $("lobby-start-btn").addEventListener("click", () => online.startGame());
  $("lobby-leave-btn").addEventListener("click", () => {
    online.leave();
    state = null;
    ui.selectedIds.clear();
    selectMode("online");
    showScreen("screen-start");
  });
}

// Reflect Identity auth state in the online mode block and refresh the table list.
function refreshOnlineModeBlock() {
  const signedOut = $("online-signed-out");
  const signedIn = $("online-signed-in");
  if (!signedOut || !signedIn) return;
  if (!net.isIdentityAvailable()) {
    signedOut.classList.remove("hidden");
    signedIn.classList.add("hidden");
    $("online-signin-btn").classList.add("hidden");
    $("online-unavailable").classList.remove("hidden");
    return;
  }
  const user = net.currentUser();
  signedOut.classList.toggle("hidden", !!user);
  signedIn.classList.toggle("hidden", !user);
  if (user) {
    $("online-user-name").textContent = user.name || user.email || "Player";
    const dn = $("online-display-name");
    if (dn && !dn.value) dn.value = user.name || (loadPrefs().userName || "").trim() || "";
    if (!$("online-room-name").value) $("online-room-name").value = `${onlineDisplayName()}'s game`;
    loadOnlineRoomList();
  }
}

async function loadOnlineRoomList() {
  const host = $("online-room-list");
  if (!host) return;
  host.innerHTML = `<p class="muted small-help">Loading…</p>`;
  try {
    const rooms = await online.refreshRoomList();
    renderOnlineRoomList(rooms);
  } catch (e) {
    host.innerHTML = `<p class="muted small-help">Couldn't load tables — ${escapeHTML(e.message || "try again")}.</p>`;
  }
}

function renderOnlineRoomList(rooms) {
  const host = $("online-room-list");
  host.innerHTML = "";
  if (!rooms.length) {
    host.innerHTML = `<p class="muted small-help">No public tables right now — create one!</p>`;
    return;
  }
  for (const r of rooms) {
    const row = document.createElement("div");
    row.className = "online-room-row";
    const info = document.createElement("div");
    info.className = "online-room-info";
    info.innerHTML = `<strong>${escapeHTML(r.name)}</strong><span>${r.players}/${r.maxPlayers} players</span>`;
    row.appendChild(info);
    const btn = document.createElement("button");
    btn.className = "pill";
    btn.textContent = "Join";
    btn.addEventListener("click", () => joinOnlineRoom(r.roomId, ""));
    row.appendChild(btn);
    host.appendChild(row);
  }
}

async function onlineCreate() {
  const opts = {
    name: $("online-room-name").value.trim(),
    visibility: onlineVisibility,
    password: $("online-room-password").value,
    displayName: onlineDisplayName(),
    maxPlayers: 4,
  };
  if (opts.visibility === "private" && !opts.password) { toast("Set a password for a private table."); return; }
  $("online-create-btn").disabled = true;
  try {
    const res = await online.createRoom(opts);
    enterLobbyScreen(res);
  } catch (e) {
    toast(e.message || "Couldn't create the table.");
  } finally {
    $("online-create-btn").disabled = false;
  }
}

function onlineJoin() {
  const code = $("online-join-code").value.trim().toUpperCase();
  if (!code) { toast("Enter a table code."); return; }
  joinOnlineRoom(code, $("online-join-password").value);
}

async function joinOnlineRoom(code, password) {
  try {
    const res = await online.joinRoom(code, password, onlineDisplayName());
    if (res.status === "lobby") {
      enterLobbyScreen(res);
    } else {
      // Game already in progress — show the lobby shell; the poll will adopt
      // the live state and route into the play screen momentarily.
      showScreen("screen-online-lobby");
      $("lobby-status").textContent = "Joining game…";
    }
  } catch (e) {
    toast(e.message || "Couldn't join that table.");
  }
}

function enterLobbyScreen(res) {
  $("lobby-room-name").textContent = res.name || "Benny";
  $("lobby-room-code").textContent = res.roomId;
  renderLobbyRoster(res.players, { status: "lobby" });
  showScreen("screen-online-lobby");
}

// Called both from enterLobbyScreen and from each poll while we have a session.
function renderLobbyRoster(players, server) {
  const list = $("lobby-player-list");
  if (!list) return;
  list.innerHTML = "";
  const ordered = [...(players || [])].sort((a, b) => a.seat - b.seat);
  for (const p of ordered) {
    const row = document.createElement("div");
    row.className = "lobby-player" + (p.connected ? "" : " is-disconnected");
    const tags = [];
    if (p.seat === 0) tags.push("host");
    if (p.seat === online.mySeat()) tags.push("you");
    row.innerHTML = `<span>${escapeHTML(p.name)}</span>${tags.length ? `<span class="lobby-tag">${tags.join(" · ")}</span>` : ""}`;
    list.appendChild(row);
  }
  const startBtn = $("lobby-start-btn");
  if (startBtn) {
    const canStart = online.isHost() && ordered.length >= 2 && (!server || server.status === "lobby");
    startBtn.classList.toggle("hidden", !canStart);
  }
  const statusEl = $("lobby-status");
  if (statusEl && (!server || server.status === "lobby")) {
    statusEl.textContent = online.isHost()
      ? (ordered.length >= 2 ? "Ready when you are — start the game." : "Waiting for at least one more player…")
      : "Waiting for the host to start…";
  }
}

// ---------- Boot ----------
function boot() {
  buildStart();
  wireUp();
  buildOnlineUI();
  initOnline();
  selectMostRecentSavedMode();
  setupCardZoom();
  window.addEventListener("resize", () => {
    layoutHand();
    updateMeldOverflowFlags();
  });
  showScreen("screen-start");
  showWelcomeModalIfNeeded();
}
document.addEventListener("DOMContentLoaded", boot);

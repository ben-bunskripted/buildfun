// Benny — UI controller.

import { renderCard, renderCardBack, compareForSort, SUIT_GLYPH, isWildcard, setCardStyle } from "./cards.js";
import { randomInt, shuffleInPlace } from "./rng.js";
import {
  createMatch, startNextRound, beginTurn, currentPlayer, topOfDiscard,
  drawFromDeck, drawFromDiscard, placeNewSet, addToSet, swapWildcard,
  discard, isMatchOver, advanceToNextRound, matchWinnerIndex,
  WILDCARD_ORDER, ROUND_NAMES, TOTAL_ROUNDS, serialize, hydrate,
} from "./game.js";
import { validateNewSet, validateAddition, describeRunArrangement, describeAddition } from "./rules.js";
import { makeHandReorderable } from "./dragdrop.js";
import { planTurn } from "./ai.js";
import {
  createScoringMatch, startScoringRound, submitScoringRound,
  isScoringMatchOver, advanceScoringRound, scoringWinnerIndex,
} from "./scoring.js";
import { save as storageSave, load as storageLoad, clear as storageClear, loadPrefs, savePrefs, hasSnapshot } from "./storage.js";
import * as tutorial from "./tutorial.js";
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
};

const CARD_SIZE_VALUES = new Set(["s", "m", "l", "xl"]);

function applyCardSizePref(size) {
  const value = CARD_SIZE_VALUES.has(size) ? size : "m";
  document.documentElement.dataset.cardSize = value;
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
  setCardStyle(ui.cardStyle);
  applyCardSizePref(ui.cardSize);
}

// ---------- Persistence ----------
function persist() {
  if (!state) return;
  // The tutorial match is ephemeral — never write it to localStorage so a
  // reload doesn't leave the user a half-finished tutorial as a resumable
  // game on the start screen.
  if (state.isTutorial) return;
  storageSave({ mode: state.mode, state: serialize(state), ui: { mode: ui.mode } });
}
function discardSave() { storageClear(); }

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
    modeSeg.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    ui.mode = btn.dataset.mode;
    showModeBlock();
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
  });
  renderScoringNames();

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

  // Card size picker — overrides the breakpoint-driven default.
  const sizeSeg = $("card-size-seg");
  sizeSeg.querySelectorAll(".seg-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.size === ui.cardSize);
  });
  sizeSeg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    sizeSeg.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    ui.cardSize = btn.dataset.size;
    applyCardSizePref(ui.cardSize);
    savePrefs({ ...loadPrefs(), cardSize: ui.cardSize });
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
  for (const m of ["multiplayer", "cpu", "scoring"]) {
    $(`mode-${m}`).classList.toggle("hidden", ui.mode !== m);
  }
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
    inp.addEventListener("input", () => { ui.scoring.playerNames[i] = inp.value.trim(); });
    wrap.appendChild(inp);
  }
}

function onStartMatch() {
  const start = () => {
    if (ui.mode === "scoring") return startScoringMatch();
    if (ui.mode === "cpu") return startSoloMatch();
    return startMultiplayerMatch();
  };
  if (hasSnapshot()) {
    showConfirm({
      title: "Start a new match?",
      body: "You have a saved match in progress. Starting a new one will overwrite it.",
      confirmLabel: "Start new",
      onConfirm: () => { storageClear(); start(); },
    });
    return;
  }
  start();
}

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
  state = createScoringMatch(names, 0);
  startScoringRound(state);
  persist();
  goScoringRoundScreen();
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
  let roundWon = false;

  for (const action of plan) {
    let r;
    if (action.type === "drawDeck") r = drawFromDeck(state);
    else if (action.type === "drawDiscard") r = drawFromDiscard(state);
    else if (action.type === "play") r = placeNewSet(state, action.arrangement);
    else if (action.type === "add") r = addToSet(state, action.setId, action.arrangement);
    else if (action.type === "swap") r = swapWildcard(state, action.setId, action.positionIndex, action.naturalCardId);
    else if (action.type === "discard") { r = discard(state, action.cardId); if (r.ok && r.wonRound) roundWon = true; }
    else continue;
    if (!r || !r.ok) {
      // AI produced an illegal action — surface and abort cleanly to a discard.
      console.warn("CPU action failed:", action, r);
      break;
    }
  }
  // Safety: if the plan never discarded (e.g., interrupted), force a discard.
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
    name.textContent = i === state.currentPlayerIndex ? `${p.name} (you)` : p.name;
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

function renderHand() {
  const hand = $("hand");
  hand.innerHTML = "";
  const me = currentPlayer(state);
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

  if (ui.handFanned) {
    // Heavy overlap so cards stack like in a real hand. Show ~45% of each
    // card's left edge.
    const overlap = -Math.round(cardW * 0.55);
    hand.style.setProperty("--hand-overlap", `${overlap}px`);
    // Per-card tilt. Cap the total spread so 8 cards don't look like an
    // explosion.
    const stepDeg = n > 1 ? Math.min(4, 22 / (n - 1)) : 0;
    const startDeg = -stepDeg * (n - 1) / 2;
    cards.forEach((c, i) => {
      const rot = startDeg + stepDeg * i;
      c.style.setProperty("--card-rot", `${rot.toFixed(2)}deg`);
    });
    return;
  }

  // Spread mode — pack to width only if natural layout doesn't fit.
  const cs = getComputedStyle(hand);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const available = hand.clientWidth - padX;
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
  if (state) persist();
  // If the user bails mid-tutorial via Save & exit, tear down the coach so
  // it doesn't linger on the start screen.
  tutorial.endTutorial();
  state = null;
  ui.selectedIds.clear();
  renderResumeBanner();
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

  // Drag reorder
  makeHandReorderable($("hand"), (fromIndex, toIndex) => {
    const me = currentPlayer(state);
    const [moved] = me.hand.splice(fromIndex, 1);
    me.hand.splice(toIndex, 0, moved);
    renderHand();
  });

  // Draw pile / discard pile
  $("draw-pile").addEventListener("click", () => {
    if (state.phase !== "mustDraw") return;
    const r = drawFromDeck(state);
    if (!r.ok) toast(r.reason);
    persist();
    renderAll();
    if (r.ok) tutorial.notify("drawDeck");
  });
  $("discard-pile").addEventListener("click", () => {
    if (state.phase === "mustDraw") {
      const r = drawFromDiscard(state);
      if (!r.ok) toast(r.reason);
      persist();
      renderAll();
      return;
    }
    if (state.phase === "canAct" && ui.selectedIds.size === 1) {
      const id = [...ui.selectedIds][0];
      const r = discard(state, id);
      if (!r.ok) { toast(r.reason); return; }
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
    state = null;
    ui.selectedIds.clear();
    discardSave();
    showScreen("screen-start");
    renderResumeBanner();
  });

  // Modal closers
  $("modal-pick-cancel").addEventListener("click", () => $("modal-pick-set").classList.add("hidden"));
  $("modal-swap-cancel").addEventListener("click", () => $("modal-swap").classList.add("hidden"));

  // Scoring submit
  $("sc-submit").addEventListener("click", onScoringSubmit);

  // Resume banner
  $("resume-go").addEventListener("click", resumeFromSave);
  $("resume-discard").addEventListener("click", () => {
    discardSave();
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
    row.addEventListener("click", () => {
      modal.classList.add("hidden");
      const v = opt.validation;
      if (opt.set.type === "number") {
        finalizeAddition(opt.set, v.arrangement);
      } else {
        if (v.arrangements.length === 1) finalizeAddition(opt.set, v.arrangements[0]);
        else chooseAdditionArrangement(v.arrangements, opt.set, (chosen) => finalizeAddition(opt.set, chosen));
      }
    });
    list.appendChild(row);
  }
  modal.classList.remove("hidden");
}

function finalizeAddition(set, arrangement) {
  const r = addToSet(state, set.id, arrangement);
  if (!r.ok) { toast(r.reason); return; }
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
  if (result.wonRound) goRoundEnd();
  else routeTurnStart();
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
  $("round-end-title").textContent = `Round ${ROUND_NAMES[state.round - 1] || state.round} complete`;
  $("round-end-winner").innerHTML = `<strong>${escapeHTML(state.players[winnerIdx].name)}</strong> took the round.`;
  const tbody = $("round-end-rows");
  tbody.innerHTML = "";
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    const tr = document.createElement("tr");
    if (i === winnerIdx) tr.className = "winner-row";
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
  recordAndRenderRewards();
  buildConfetti();
  discardSave();
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
function renderResumeBanner() {
  const snapshot = storageLoad();
  const banner = $("resume-banner");
  if (!snapshot || !snapshot.state || !snapshot.state.mode) {
    if (snapshot) discardSave();
    banner.classList.add("hidden");
    return;
  }
  const s = snapshot.state;
  const detail = s.mode === "scoring"
    ? `Scoring · round ${s.round}/${TOTAL_ROUNDS}`
    : `${s.mode === "cpu" ? "Solo" : "Multiplayer"} · round ${s.round || 1}/${TOTAL_ROUNDS}`;
  $("resume-banner-detail").textContent = ` ${detail}`;
  banner.classList.remove("hidden");
}

function resumeFromSave() {
  const snapshot = storageLoad();
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
}

// ---------- Boot ----------
function boot() {
  buildStart();
  wireUp();
  renderResumeBanner();
  setupCardZoom();
  window.addEventListener("resize", () => {
    layoutHand();
    updateMeldOverflowFlags();
  });
  showScreen("screen-start");
  showWelcomeModalIfNeeded();
}
document.addEventListener("DOMContentLoaded", boot);

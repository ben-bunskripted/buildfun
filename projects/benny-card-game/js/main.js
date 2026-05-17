// Benny — UI controller.

import { renderCard, renderCardBack, compareForSort, SUIT_GLYPH, isWildcard, setCardStyle } from "./cards.js";
import { randomInt, shuffleInPlace } from "./rng.js";
import {
  createMatch, startNextRound, beginTurn, currentPlayer, topOfDiscard,
  drawFromDeck, drawFromDiscard, placeNewSet, addToSet, swapWildcard,
  discard, isMatchOver, advanceToNextRound, matchWinnerIndex,
  WILDCARD_ORDER, TOTAL_ROUNDS, serialize, hydrate,
} from "./game.js";
import { validateNewSet, validateAddition, describeRunArrangement, describeAddition } from "./rules.js";
import { makeHandReorderable } from "./dragdrop.js";
import { planTurn } from "./ai.js";
import {
  createScoringMatch, startScoringRound, submitScoringRound,
  isScoringMatchOver, advanceScoringRound, scoringWinnerIndex,
} from "./scoring.js";
import { save as storageSave, load as storageLoad, clear as storageClear, loadPrefs, savePrefs, hasSnapshot } from "./storage.js";

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
};

// Apply persisted card style preference before any cards are rendered.
{
  const prefs = loadPrefs();
  if (prefs.cardStyle === "classic" || prefs.cardStyle === "modern") {
    ui.cardStyle = prefs.cardStyle;
  }
  setCardStyle(ui.cardStyle);
}

// ---------- Persistence ----------
function persist() {
  if (!state) return;
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
const DEFAULT_NAMES = ["Ben", ...shuffleInPlace(["Roxy","Kye","Tim","Wayne","Nath","Sean","Fiona","Jon","Zach"]).slice(0, 3)];
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

  $("start-btn").addEventListener("click", onStartMatch);

  // Rules modal — opened from start screen, also from play / scoring top bars (wired in wireUp).
  const rulesModal = $("modal-rules");
  $("rules-btn").addEventListener("click", openRules);
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
  if (p.kind === "cpu") runCpuTurn();
  else goPassScreen();
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
  };
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
  renderOthers();
  renderMiddle();
  renderSelfMelds();
  renderHand();
  renderActions();
}

function renderTopBar() {
  $("bar-round").textContent = state.round;
  $("bar-wild").textContent = state.wildcardRank;
  $("bar-turn").textContent = currentPlayer(state).name;
}

function renderOthers() {
  const wrap = $("others");
  wrap.innerHTML = "";
  for (let i = 0; i < state.players.length; i++) {
    if (i === state.currentPlayerIndex) continue;
    const p = state.players[i];
    const row = document.createElement("div");
    row.className = "other-player";
    const head = document.createElement("div");
    head.className = "other-player-head";
    const name = document.createElement("div");
    name.className = "player-name";
    name.textContent = p.name;
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
    empty.textContent = "No sets played yet.";
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
      ? { wild: true, represents: { rank: c.representsRank, suit: c.representsSuit || (set.type === "number" ? c.card.suit : c.representsSuit) } }
      : {};
    const cardEl = renderCard(c.card, opts);
    cardEl.dataset.positionIndex = String(i);
    el.appendChild(cardEl);
  }
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

function renderSelfMelds() {
  const wrap = $("self-melds");
  wrap.innerHTML = "";
  const head = document.createElement("div");
  head.className = "self-melds-head";
  const me = currentPlayer(state);
  head.innerHTML = `<span><strong>${escapeHTML(me.name)}</strong> &middot; Score ${me.score}</span><span class="muted">Your sets</span>`;
  wrap.appendChild(head);
  const ml = document.createElement("div");
  ml.className = "melds";
  const sets = state.table.filter(s => s.ownerIndex === state.currentPlayerIndex);
  if (!sets.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.fontSize = "12px";
    empty.textContent = "Play 3+ matching cards to open this round.";
    ml.appendChild(empty);
  } else {
    sets.forEach(s => ml.appendChild(renderMeld(s)));
  }
  wrap.appendChild(ml);
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
  $("add-set-btn").disabled = !canAdd;
  $("swap-btn").disabled = !canSwap;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));
}

// ---------- User interactions ----------
function exitToStart() {
  if (state) persist();
  state = null;
  ui.selectedIds.clear();
  renderResumeBanner();
  showScreen("screen-start");
}

function wireUp() {
  $("play-exit-btn").addEventListener("click", exitToStart);
  $("scoring-exit-btn").addEventListener("click", exitToStart);
  $("play-rules-btn").addEventListener("click", openRules);
  $("scoring-rules-btn").addEventListener("click", openRules);
  $("play-feedback-btn").addEventListener("click", openFeedback);
  $("scoring-feedback-btn").addEventListener("click", openFeedback);
  wireInstallLink();

  // Card selection (delegated)
  $("hand").addEventListener("click", (e) => {
    if (state.phase !== "canAct") return;
    const card = e.target.closest(".card.in-hand");
    if (!card) return;
    const id = card.dataset.cardId;
    if (ui.selectedIds.has(id)) ui.selectedIds.delete(id);
    else ui.selectedIds.add(id);
    renderAll();
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
    me.hand = [...me.hand].sort(compareForSort);
    renderHand();
  });

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
}

function doPlace(arrangement) {
  const r = placeNewSet(state, arrangement);
  if (!r.ok) { toast(r.reason); return; }
  ui.selectedIds.clear();
  persist();
  renderAll();
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
      const opts = c.isWild ? { wild: true, represents: { rank: c.representsRank, suit: c.representsSuit || c.card.suit } } : {};
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
      const wildPreview = renderCard(c.card, { wild: true, represents: { rank: needRank, suit: needSuit || c.card.suit } });
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
  if (result.wonRound) goRoundEnd();
  else routeTurnStart();
}

// ---------- Scoring-mode screen ----------
function goScoringRoundScreen() {
  showScreen("screen-scoring");
  $("sc-round").textContent = state.round;
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
  $("round-end-title").textContent = `Round ${state.round} complete`;
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
  $("continue-btn").textContent = state.round >= TOTAL_ROUNDS ? "See match result" : `Continue to round ${state.round + 1}`;
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
  buildConfetti();
  discardSave();
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

// ---------- Boot ----------
function boot() {
  buildStart();
  wireUp();
  renderResumeBanner();
  setupCardZoom();
  showScreen("screen-start");
}
document.addEventListener("DOMContentLoaded", boot);

// Sh!thead — UI controller. Screen routing, setup, swap phase, the play table,
// the CPU turn driver, and game-over → stats/achievements.

import { renderCard, renderCardBack, setCardStyle } from "./cards.js";
import { makeHandReorderable } from "./dragdrop.js";
import {
  createState, applyAction, currentZone, legalSummary, serialize,
} from "./game.js";
import { comparisonCard, requirement, SUIT_GLYPH, value } from "./rules.js";
import { planTurn, planSwaps } from "./ai.js";
import * as storage from "./storage.js";
import { recordMatch, addAchievements, accrueProgress, getProfile, listProfiles } from "./profiles.js";
import { evaluate, evaluateProgress, emptySummary, achievementById, ACHIEVEMENTS, PROGRESS_ACHIEVEMENTS } from "./achievements.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Player-naming conventions shared with Benny: the device owner's name is
// remembered (prefs.name, captured by the welcome modal, default "Ben"), and
// opponents draw from a shuffled bot pool so suggested names line up per session.
const BOT_POOL = ["Roxy", "Kye", "Tim", "Wayne", "Nath", "Sean", "Fiona", "Jon", "Zach"];
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
let DEFAULT_NAMES = [];
function rebuildDefaultNames() {
  DEFAULT_NAMES = [((prefs.name || "").trim() || "Ben"), ...shuffled(BOT_POOL)];
}
function defaultName(i) { return DEFAULT_NAMES[i] || `Player ${i + 1}`; }

let prefs = storage.loadPrefs();
let state = null;
let mode = "cpu";
const ui = {
  viewerId: null,   // whose cards we currently show
  humanId: null,    // the device owner in solo mode
  humans: [],       // ids of all human-controlled players
  selected: [],     // selected card ids in hand/face-up
  summaries: {},    // per-human achievement tally
  handOrders: {},   // per-viewer manual hand order (from drag-reorder), by id
  pendingHandRender: false, // a hand rebuild deferred because a drag is live
  toastedAch: new Set(),    // achievements already toasted this match
  tutorialActive: false,    // a guided tutorial is running (pauses the CPUs)
  ephemeral: false,         // practice game — don't write it to a save slot
  cpuTimer: null,
  busy: false,      // an action animation is in flight
  setup: { players: 3, difficulty: "normal", eightMode: "reverse", two: true, ten: true, seven: false, jokers: false, swap: true, fourkind: true, replay: true },
};

// ---------------------------------------------------------------- boot
function boot() {
  applyPrefs();
  rebuildDefaultNames();
  wireStart();
  wireSettings();
  wireModals();
  wirePlay();
  wireSwap();
  wireOver();
  renderHowto();
  renderSaved();
  renderTourOffer();
  renderVersionStamp();
  setupCardZoom();
  showScreen("screen-start");
  showWelcomeIfNeeded();
}

// First-launch name capture (mirrors Benny). Stored under prefs.name and reused
// everywhere a default player name is suggested.
function showWelcomeIfNeeded() {
  if (prefs.name && prefs.name.trim()) return;
  const modal = $("#modal-welcome");
  const form = $("#welcome-form");
  const input = $("#welcome-name");
  if (!modal || !form) return;
  modal.hidden = false;
  setTimeout(() => input.focus(), 0);
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = (input.value || "").trim();
    if (!name) { input.focus(); return; }
    prefs.name = name; savePrefs();
    rebuildDefaultNames();
    modal.hidden = true;
    renderNames();
  };
}

// ---------------------------------------------------------------- card zoom
// Hover (desktop) or long-press (touch) a table card — the discard top, an
// opponent's face-up, your own face-ups — to see an enlarged copy. Hand cards
// and face-down backs are excluded (already legible / nothing to reveal).
function setupCardZoom() {
  let zoom = null, timer = null;
  const hide = () => { if (zoom) { zoom.remove(); zoom = null; } };
  function zoomable(target) {
    const card = target && target.closest && target.closest(".card");
    if (!card || !card.closest("#screen-play")) return null;
    if (["in-hand", "back", "dragging", "drag-placeholder"].some((c) => card.classList.contains(c))) return null;
    return card;
  }
  function show(card) {
    hide();
    const clone = card.cloneNode(true);
    // Keep "card" + render-mode classes so the classic corner/pip CSS still
    // styles it; drop interactive/positioning classes from the table.
    const keep = [...card.classList].filter((c) => ["card", "is-modern", "joker"].includes(c) || c.startsWith("suit-"));
    clone.className = "zoom-card " + keep.join(" ");
    clone.style.cssText = "";
    const wrap = document.createElement("div");
    wrap.className = "card-zoom";
    wrap.appendChild(clone);
    document.body.appendChild(wrap);
    zoom = wrap;
  }
  // Touch long-press only — the desktop hover-zoom was distracting on the
  // table cards, so it's been dropped.
  document.addEventListener("touchstart", (e) => {
    const c = zoomable(e.target);
    if (!c) return;
    timer = setTimeout(() => show(c), 380);
  }, { passive: true });
  const cancel = () => { clearTimeout(timer); hide(); };
  document.addEventListener("touchend", cancel);
  document.addEventListener("touchmove", cancel);
  document.addEventListener("touchcancel", cancel);
}

function applyPrefs() {
  setCardStyle(prefs.cardStyle || "modern");
  document.documentElement.dataset.cardSize = prefs.cardSize || "m";
  if (prefs.animate === undefined) prefs.animate = true;
  if (prefs.selectMatching === undefined) prefs.selectMatching = true;
  if (prefs.handFanned === undefined) prefs.handFanned = true;
  // reflect into settings controls
  segSelect("#seg-cardstyle", "cs", prefs.cardStyle || "modern");
  segSelect("#seg-cardsize", "sz", prefs.cardSize || "m");
  segSelect("#seg-cardsize-menu", "sz", prefs.cardSize || "m");
  const anim = $("#opt-animate"); if (anim) anim.checked = prefs.animate !== false;
  const match = $("#match-toggle-input"); if (match) match.checked = prefs.selectMatching !== false;
  const fan = $("#opt-fan"); if (fan) fan.checked = prefs.handFanned !== false;
  syncFanLabel();
}

function savePrefs() { storage.savePrefs(prefs); }

// ---------------------------------------------------------------- screens
function showScreen(id) {
  $$(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
}

// ---------------------------------------------------------------- seg helper
function segSelect(sel, attr, val) {
  const seg = $(sel);
  if (!seg) return;
  $$("button", seg).forEach((b) => b.classList.toggle("on", b.dataset[attr] === String(val)));
}
function wireSeg(sel, attr, onPick) {
  const seg = $(sel);
  if (!seg) return;
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $$("button", seg).forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    onPick(b.dataset[attr]);
  });
}

// ---------------------------------------------------------------- start screen
function wireStart() {
  $$(".mode-tile").forEach((t) => t.addEventListener("click", () => {
    $$(".mode-tile").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    mode = t.dataset.mode;
    $("#setup-offline").hidden = mode === "online";
    $("#setup-online").hidden = mode !== "online";
    $("#field-difficulty").hidden = mode !== "cpu";
    renderNames();
  }));

  wireSeg("#seg-players", "n", (n) => { ui.setup.players = +n; renderNames(); });
  wireSeg("#seg-difficulty", "d", (d) => { ui.setup.difficulty = d; });
  wireSeg("#seg-eight", "e", (e) => { ui.setup.eightMode = e; });
  $("#opt-two").addEventListener("change", (e) => ui.setup.two = e.target.checked);
  $("#opt-ten").addEventListener("change", (e) => ui.setup.ten = e.target.checked);
  $("#opt-seven").addEventListener("change", (e) => ui.setup.seven = e.target.checked);
  $("#opt-jokers").addEventListener("change", (e) => ui.setup.jokers = e.target.checked);
  $("#opt-swap").addEventListener("change", (e) => ui.setup.swap = e.target.checked);
  $("#opt-fourkind").addEventListener("change", (e) => ui.setup.fourkind = e.target.checked);
  $("#opt-replay").addEventListener("change", (e) => ui.setup.replay = e.target.checked);

  $("#start-btn").addEventListener("click", onDeal);
  $("#howto-link").addEventListener("click", () => openModal("modal-howto"));
  $("#settings-link").addEventListener("click", () => openModal("modal-settings"));
  $("#stats-btn").addEventListener("click", openStats);
  $("#tour-btn").addEventListener("click", startTutorial);
  $("#tour-dismiss").addEventListener("click", () => { prefs.tutorialDone = true; savePrefs(); renderTourOffer(); });
  $("#howto-tour").addEventListener("click", startTutorial);
  // Footer control mirrors Benny: "Dismiss tutorial" while the offer shows,
  // "Replay tutorial" once it's been hidden — so the tour is always reachable.
  $("#tutorial-foot").addEventListener("click", () => {
    if (prefs.tutorialDone) startTutorial();
    else { prefs.tutorialDone = true; savePrefs(); renderTourOffer(); }
  });

  // Saved-games section: per-row Resume / Discard.
  $("#saved-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button"); if (!btn) return;
    const row = btn.closest(".saved-row"); if (!row) return;
    const m = row.dataset.mode;
    if (btn.dataset.act === "resume") resumeMode(m);
    else if (btn.dataset.act === "discard") {
      showConfirm("Discard this saved game?", "It will be deleted for good.", () => { storage.clear(m); renderSaved(); });
    }
  });

  renderNames();
}

function renderNames() {
  const host = $("#player-names");
  host.replaceChildren();
  const n = ui.setup.players;
  if (mode === "cpu") {
    host.appendChild(nameInput("you", defaultName(0), true));
    const bots = [];
    for (let i = 1; i < n; i++) bots.push(defaultName(i));
    const note = document.createElement("p");
    note.className = "cpu-note";
    note.textContent = `vs ${bots.join(" & ")}`;
    host.appendChild(note);
  } else {
    for (let i = 0; i < n; i++) {
      host.appendChild(nameInput("p" + i, (prefs.localNames && prefs.localNames[i]) || defaultName(i), true));
    }
  }
  renderDealerSelect();
}
function nameInput(key, val, editable) {
  const wrap = document.createElement("label");
  wrap.className = "name-input";
  const input = document.createElement("input");
  input.type = "text"; input.maxLength = 16; input.value = val; input.dataset.key = key;
  if (!editable) input.disabled = true;
  input.addEventListener("input", renderDealerSelect);
  wrap.appendChild(input);
  return wrap;
}

function collectSetup() {
  const inputs = $$("#player-names input");
  const names = inputs.map((i) => (i.value.trim() || i.placeholder || "Player"));
  const players = [];
  if (mode === "cpu") {
    const youName = names[0] || defaultName(0);
    prefs.name = youName; savePrefs(); DEFAULT_NAMES[0] = youName;   // keep bot order stable
    players.push({ id: "you", name: youName, isCPU: false, difficulty: "normal" });
    for (let i = 1; i < ui.setup.players; i++) {
      players.push({ id: "cpu" + i, name: defaultName(i), isCPU: true, difficulty: ui.setup.difficulty });
    }
  } else {
    prefs.localNames = names; savePrefs();
    for (let i = 0; i < ui.setup.players; i++) {
      players.push({ id: "p" + i, name: names[i] || ("Player " + (i + 1)), isCPU: false, difficulty: "normal" });
    }
  }
  const options = {
    eightMode: ui.setup.eightMode,
    twoPower: ui.setup.two,
    tenPower: ui.setup.ten,
    sevenPower: ui.setup.seven,
    jokers: ui.setup.jokers,
    swapPhase: ui.setup.swap,
    fourKindAcrossTurns: ui.setup.fourkind,
    replayOnBurn: ui.setup.replay,
  };
  return { players, options };
}

function onDeal() {
  if (mode === "online") return;
  if (storage.hasSnapshot(mode)) {
    showConfirm("Start a new game?", "This will overwrite your saved game.", startNewGame);
  } else {
    startNewGame();
  }
}

function startNewGame() {
  const { players, options } = collectSetup();
  const { dealerId, isRandom } = resolveDealer(players);
  state = createState({ players, options, forcedStarter: dealerId });
  ui.humans = players.filter((p) => !p.isCPU).map((p) => p.id);
  ui.humanId = ui.humans[0];
  ui.handOrders = {};
  ui.toastedAch = new Set();
  ui.ephemeral = false;
  ui.summaries = {};
  for (const id of ui.humans) ui.summaries[id] = { ...emptySummary(), difficulty: ui.setup.difficulty, eightMode: options.eightMode, total: players.length };
  // CPUs auto-swap + ready up front.
  for (const p of state.players) {
    if (p.isCPU) {
      for (const sw of planSwaps(p)) applyAction(state, { type: "swap", playerId: p.id, handId: sw.handId, faceUpId: sw.faceUpId });
      applyAction(state, { type: "ready", playerId: p.id });
    }
  }
  persist();
  const proceed = () => { if (state.phase === "swap") beginSwapQueue(); else enterPlay(); };
  // Dealer spinner: when "Random" was chosen, spin the reel to reveal who opens
  // before dealing into swap/play; otherwise go straight in.
  if (isRandom) {
    const idx = players.findIndex((p) => p.id === dealerId);
    runReveal(players.map((p) => p.name), Math.max(0, idx), proceed);
  } else {
    proceed();
  }
}

// ---------------------------------------------------------------- dealer spinner
// Read the dealer dropdown into a starter choice: a random spin, the rules'
// lowest-card opener, or a specific seat.
function resolveDealer(players) {
  const sel = $("#dealer-select");
  const v = sel ? sel.value : "lowest";
  if (v === "lowest") return { dealerId: null, isRandom: false };
  if (v === "random") return { dealerId: players[Math.floor(Math.random() * players.length)].id, isRandom: true };
  const i = parseInt(v.replace("seat-", ""), 10);
  return { dealerId: players[i] ? players[i].id : null, isRandom: false };
}

// Suggested/typed names for each seat, in player order (drives the dropdown).
function currentSetupNames() {
  const n = ui.setup.players;
  const inputs = $$("#player-names input");
  const out = [];
  if (mode === "cpu") {
    out.push((inputs[0] && inputs[0].value.trim()) || defaultName(0));
    for (let i = 1; i < n; i++) out.push(defaultName(i));
  } else {
    for (let i = 0; i < n; i++) out.push((inputs[i] && inputs[i].value.trim()) || defaultName(i));
  }
  return out;
}

function renderDealerSelect() {
  const sel = $("#dealer-select");
  if (!sel) return;
  const prev = sel.value;
  sel.replaceChildren();
  const add = (val, label) => { const o = document.createElement("option"); o.value = val; o.textContent = label; sel.appendChild(o); };
  add("random", "🎰 Random (spin)");
  add("lowest", "Lowest card");
  currentSetupNames().forEach((nm, i) => add("seat-" + i, nm));
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : "random";
}

// Slot-machine reel that scrolls through the seat names and lands on the
// opener (ported from Benny). onDone fires when the player taps Continue.
function runReveal(names, finalIndex, onDone) {
  const reel = $("#reel");
  const nameEl = $("#reveal-name");
  const cont = $("#reveal-continue");
  showScreen("screen-reveal");
  cont.hidden = true;
  nameEl.textContent = "";
  reel.replaceChildren();
  const ITEM_H = 56, FRAME_H = 200, cycles = 8;
  for (let c = 0; c < cycles; c++) for (const n of names) {
    const d = document.createElement("div"); d.className = "reel-item"; d.textContent = n; reel.appendChild(d);
  }
  const targetIdx = (cycles - 2) * names.length + finalIndex;
  const targetY = targetIdx * ITEM_H + ITEM_H / 2 - FRAME_H / 2;
  const finish = () => {
    reel.style.transform = `translateY(${-targetY}px)`;
    nameEl.textContent = `${names[finalIndex]} starts`;
    cont.hidden = false;
    cont.onclick = onDone;
  };
  if (prefs.animate === false) { finish(); return; }
  const duration = 2600, start = performance.now();
  function frame(t) {
    const p = Math.min(1, (t - start) / duration);
    const ease = 1 - Math.pow(1 - p, 3.5);
    reel.style.transform = `translateY(${-(targetY * ease)}px)`;
    if (p < 1) requestAnimationFrame(frame);
    else finish();
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- swap phase
let swapQueue = [];
let swapCurrent = null;

function beginSwapQueue() {
  swapQueue = ui.humans.slice();
  nextSwap();
}
function nextSwap() {
  if (state.phase !== "swap" || swapQueue.length === 0) { enterPlay(); return; }
  swapCurrent = swapQueue.shift();
  const p = byId(swapCurrent);
  ui.selected = [];
  ui.swapPick = null;
  const proceed = () => { showScreen("screen-swap"); renderSwap(); };
  if (mode === "local" && ui.humans.length > 1) {
    showPass(p.name, proceed);
  } else proceed();
}

function wireSwap() {
  $("#swap-done").addEventListener("click", () => {
    applyAction(state, { type: "ready", playerId: swapCurrent });
    persist();
    nextSwap();
  });
  $("#swap-back").addEventListener("click", () => exitToStart());
}

function renderSwap() {
  const p = byId(swapCurrent);
  $("#swap-title").textContent = ui.humans.length > 1 ? `${p.name} — swap your cards` : "Swap your cards";
  const fu = $("#swap-faceup"); fu.replaceChildren();
  const hd = $("#swap-hand"); hd.replaceChildren();
  p.faceUp.forEach((c) => {
    const el = renderCard(c, { className: "selectable" });
    if (ui.swapPick && ui.swapPick.zone === "faceUp" && ui.swapPick.id === c.id) el.classList.add("selected");
    el.addEventListener("click", () => pickSwap("faceUp", c.id));
    fu.appendChild(el);
  });
  p.hand.forEach((c) => {
    const el = renderCard(c, { className: "selectable" });
    if (ui.swapPick && ui.swapPick.zone === "hand" && ui.swapPick.id === c.id) el.classList.add("selected");
    el.addEventListener("click", () => pickSwap("hand", c.id));
    hd.appendChild(el);
  });
}

function pickSwap(zone, id) {
  if (!ui.swapPick) { ui.swapPick = { zone, id }; renderSwap(); return; }
  if (ui.swapPick.zone === zone) { ui.swapPick = { zone, id }; renderSwap(); return; }
  // one hand + one face-up selected → swap
  const handId = zone === "hand" ? id : ui.swapPick.id;
  const faceUpId = zone === "faceUp" ? id : ui.swapPick.id;
  applyAction(state, { type: "swap", playerId: swapCurrent, handId, faceUpId });
  ui.swapPick = null;
  renderSwap();
}

// ---------------------------------------------------------------- play
function wirePlay() {
  $("#play-btn").addEventListener("click", onPlaySelected);
  $("#pickup-btn").addEventListener("click", onPickup);
  $("#match-toggle-input").addEventListener("change", (e) => {
    prefs.selectMatching = e.target.checked; savePrefs();
    ui.selected = [];
    if (state) renderPlay();
  });
  $("#play-menu-btn").addEventListener("click", () => openModal("modal-menu"));
  $("#play-exit-btn").addEventListener("click", exitToStart);
  $("#menu-fan").addEventListener("click", () => setFan(prefs.handFanned === false));
  $("#menu-howto").addEventListener("click", () => { closeModals(); openModal("modal-howto"); });
  $("#menu-settings").addEventListener("click", () => { closeModals(); openModal("modal-settings"); });
  $("#menu-restart").addEventListener("click", () => { closeModals(); showConfirm("Restart game?", "Deal a fresh game with the same players?", () => startNewGame()); });
  $("#menu-quit").addEventListener("click", () => { closeModals(); exitToStart(); });
  setupHandDrag();
}

function enterPlay() {
  ui.viewerId = mode === "cpu" ? ui.humanId : state.players[state.current].id;
  ui.selected = [];
  showScreen("screen-play");
  scheduleTurn();
}

function byId(id) { return state.players.find((p) => p.id === id); }
function isHuman(p) { return !p.isCPU; }
function anyActiveHuman() { return state.players.some((p) => isHuman(p) && !p.finished); }

function scheduleTurn() {
  clearTimeout(ui.cpuTimer);
  if (state.phase === "over") { endMatch(); return; }
  const cur = state.players[state.current];

  // No human left in the running → resolve the CPU tail instantly.
  if (!anyActiveHuman()) { fastForward(); return; }

  if (cur.isCPU) {
    renderPlay();
    if (ui.tutorialActive) return;     // hold the bots while the coach is talking
    const delay = prefs.animate !== false ? 520 + Math.floor(Math.random() * 380) : 30;
    ui.cpuTimer = setTimeout(() => doAction(planTurn(state)), delay);
    return;
  }

  // Human turn.
  if (mode === "local" && cur.id !== ui.viewerId) {
    showPass(cur.name, () => { ui.viewerId = cur.id; ui.selected = []; renderPlay(); });
  } else {
    ui.viewerId = cur.id;
    renderPlay();
  }
}

function doAction(action) {
  applyAction(state, action);
  trackEvent();
  maybeToastAchievements();
  persist();
  renderPlay();
  animateEvent(state.lastEvent);
  const wait = prefs.animate !== false ? 360 : 30;
  ui.cpuTimer = setTimeout(scheduleTurn, wait);
}

// ---------------------------------------------------------------- table effects
// Fire transient feedback for the action that just resolved: the played card
// drops onto the pile, burns flash, pickups sweep, and 8-reverse / jokers pop a
// floating label. Driven from doAction so each effect plays exactly once.
function animateEvent(e) {
  if (!e || prefs.animate === false) return;
  const dz = $("#discard-zone");
  if (e.type === "play") {
    if (e.burned) {
      flashCenter("burn");
      const bz = $("#burned-zone");
      if (bz) { bz.classList.remove("pulse"); void bz.offsetWidth; bz.classList.add("pulse"); }
    } else if (dz) {
      const cards = dz.querySelectorAll(".discard-card");      // a .pile-count badge sits last, so take the last card explicitly
      const top = cards[cards.length - 1];
      if (top) { top.classList.remove("drop-in"); void top.offsetWidth; top.classList.add("drop-in"); }
    }
    if (e.joker) floatLabel("🃏 Joker!");
    else if (e.deflect) floatLabel("3 — deflected!");
    else if (e.rank === "8" && state.options.eightMode === "reverse" && !e.burned) floatLabel("Reverse ↺");
    else if (e.rank === "2" && state.options.twoPower && !e.burned) floatLabel("Reset");
  } else if (e.type === "pickup" || e.type === "blindFail") {
    flashCenter("pickup");
    if (e.count) floatLabel(`Picked up ${e.count}`);
  }
}

function flashCenter(kind) {
  const ct = $("#center-table");
  if (!ct) return;
  const fx = document.createElement("div");
  fx.className = "center-fx fx-" + kind;
  ct.appendChild(fx);
  setTimeout(() => fx.remove(), 700);
}
function floatLabel(text) {
  const ct = $("#center-table");
  if (!ct) return;
  const el = document.createElement("div");
  el.className = "float-label";
  el.textContent = text;
  ct.appendChild(el);
  setTimeout(() => el.remove(), 1100);
}

// Achievements that can be settled mid-game (no dependence on final place /
// Sh!thead status) — toast them the moment they're earned for instant feedback.
const LIVE_ACH = new Set(["reset_button", "pyromaniac", "four_play", "jokers_wild", "no_laughing"]);
function maybeToastAchievements() {
  const e = state && state.lastEvent;
  if (!e || !e.playerId) return;
  const s = ui.summaries[e.playerId];   // only tracked humans have a summary
  if (!s) return;
  const have = new Set(getProfile(byId(e.playerId).name).achievements);
  for (const id of evaluate(s)) {
    if (!LIVE_ACH.has(id) || have.has(id) || ui.toastedAch.has(id)) continue;
    ui.toastedAch.add(id);
    const a = achievementById(id);
    if (a) toast(`🏆 ${a.icon || ""} ${a.name} unlocked!`);
  }
}

function fastForward() {
  // Play out the remaining CPUs with no animation to find the Sh!thead.
  let guard = 0;
  while (state.phase === "play" && guard++ < 5000) {
    applyAction(state, planTurn(state));
    trackEvent();
  }
  persist();
  endMatch();
}

function onPlaySelected() {
  if (state.phase !== "play") return;
  const cur = state.players[state.current];
  if (cur.id !== ui.viewerId || cur.isCPU) return;
  const zone = currentZone(cur);
  if (!zone || zone === "faceDown" || ui.selected.length === 0) return;
  doAction({ type: "play", playerId: cur.id, source: zone, cardIds: ui.selected.slice() });
  ui.selected = [];
}

function onPickup() {
  if (state.phase !== "play") return;
  const cur = state.players[state.current];
  if (cur.id !== ui.viewerId || cur.isCPU) return;
  if (state.pile.length === 0) return;
  ui.selected = [];
  doAction({ type: "pickup", playerId: cur.id });
}

function onBlindFlip(cardId) {
  const cur = state.players[state.current];
  if (cur.id !== ui.viewerId || cur.isCPU) return;
  doAction({ type: "play", playerId: cur.id, source: "faceDown", cardIds: [cardId] });
}

// Endgame: pull a face-up table card into the hand (doesn't end the turn — the
// player then plays from hand as usual).
function onTakeFaceUp(cardId) {
  if (state.phase !== "play") return;
  const cur = state.players[state.current];
  if (cur.id !== ui.viewerId || cur.isCPU) return;
  ui.selected = [];
  doAction({ type: "takeFaceUp", playerId: cur.id, cardIds: [cardId] });
}

// ---------------------------------------------------------------- play render
function renderPlay() {
  if (!state) return;
  const viewer = byId(ui.viewerId) || state.players[0];
  const cur = state.players[state.current];
  const myTurn = state.phase === "play" && cur.id === viewer.id && !viewer.finished;
  const zone = myTurn ? currentZone(viewer) : null;
  const summ = myTurn ? legalSummary(state) : null;

  // turn pill
  const pill = $("#turn-pill");
  if (state.phase === "over") pill.textContent = "Game over";
  else if (myTurn && summ && summ.underAttack) pill.textContent = "🃏 Joker! Play a 3 or pick up";
  else if (myTurn && summ && summ.canTakeFaceUp && zone === "faceUp") pill.textContent = "Take your face-up cards";
  else if (myTurn) pill.textContent = zone === "faceDown" ? "Flip a face-down card" : "Your turn";
  else pill.textContent = `${cur.name} is playing…`;
  pill.classList.toggle("yours", myTurn);

  renderPlayerRows(viewer, myTurn, zone, summ);
  renderCenter(myTurn, summ);
  renderHand(viewer, myTurn, zone, summ);
  renderActions(viewer, myTurn, zone, summ);
}

// Every player as a stacked row above the deck (Benny-style): name + key stat,
// then their table cards. You come first, labelled "(you)"; your own row is the
// one with the interactive face-up / face-down cards.
function renderPlayerRows(viewer, myTurn, zone, summ) {
  const host = $("#player-rows");
  host.replaceChildren();
  const curId = state.phase === "play" ? state.players[state.current].id : null;
  const order = [viewer, ...state.players.filter((p) => p.id !== viewer.id)];
  for (const p of order) {
    const isViewer = p.id === viewer.id;
    const row = document.createElement("div");
    row.className = "player-row";
    if (p.id === curId) row.classList.add("is-current");
    if (p.finished) row.classList.add("finished");

    const head = document.createElement("div");
    head.className = "player-row-head";
    const name = document.createElement("div");
    name.className = "player-row-name";
    name.innerHTML = `<span class="pr-name-text">${escapeHtml(p.name)}${isViewer ? " (you)" : ""}</span>`;
    if (p.id === curId) {
      const t = document.createElement("span");
      t.className = "pr-badge"; t.textContent = "Turn";
      name.appendChild(t);
    }
    head.appendChild(name);
    const meta = document.createElement("div");
    meta.className = "player-row-meta";
    meta.innerHTML = p.finished
      ? `<span class="badge done">#${p.place}</span>`
      : `<span class="hand-count">✋ ${p.hand.length}</span>`;
    head.appendChild(meta);
    row.appendChild(head);

    row.appendChild(renderPlayerTable(p, {
      blindActive: isViewer && myTurn && zone === "faceDown" && !(summ && summ.underAttack),
      takeActive: isViewer && myTurn && summ && summ.canTakeFaceUp,
      deflectActive: isViewer && myTurn && summ && summ.underAttack && zone === "faceUp",
      summ,
    }));
    host.appendChild(row);
  }
  requestAnimationFrame(() => $$(".player-row-table", host).forEach(updateRowOverflow));
}

// A player's face-down + face-up table cards. The face-up sits on the face-down
// with a slight lift so the hidden card peeks out beneath it. The viewer's own
// cards are wired for blind flips / taking into hand / joker deflection.
function renderPlayerTable(p, o = {}) {
  const host = document.createElement("div");
  host.className = "player-row-table";
  host.addEventListener("scroll", () => updateRowOverflow(host), { passive: true });
  const wireUp = (up, id) => {
    if (o.takeActive) { up.classList.add("takeable"); up.addEventListener("click", () => onTakeFaceUp(id)); }
    else if (o.deflectActive) { up.classList.add("selectable"); bindSelect(up, id, "faceUp", o.summ); if (ui.selected.includes(id)) up.classList.add("selected"); }
  };
  for (let i = 0; i < p.faceDown.length; i++) {
    const stack = document.createElement("div");
    stack.className = "mini-stack";
    const back = renderCardBack({ className: o.blindActive ? "selectable blind" : "" });
    if (o.blindActive) back.addEventListener("click", () => onBlindFlip(p.faceDown[i].id));
    stack.appendChild(back);
    if (p.faceUp[i]) {
      const up = renderCard(p.faceUp[i], { className: "on-top" });
      wireUp(up, p.faceUp[i].id);
      stack.appendChild(up);
    }
    host.appendChild(stack);
  }
  // any face-up beyond the face-down count (no card hidden under these)
  for (let i = p.faceDown.length; i < p.faceUp.length; i++) {
    const up = renderCard(p.faceUp[i], {});
    wireUp(up, p.faceUp[i].id);
    host.appendChild(up);
  }
  if (!p.faceDown.length && !p.faceUp.length) {
    const none = document.createElement("span");
    none.className = "pr-empty"; none.textContent = "—";
    host.appendChild(none);
  }
  return host;
}

// Gold edge hint when a row's cards overflow horizontally and can be scrolled.
function updateRowOverflow(el) {
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 2) { el.classList.remove("ov-left", "ov-right"); return; }
  el.classList.toggle("ov-left", el.scrollLeft > 2);
  el.classList.toggle("ov-right", el.scrollLeft < max - 2);
}

function renderCenter(myTurn, summ) {
  $("#deck-count").textContent = state.deck.length;
  $("#deck-stack").classList.toggle("empty", state.deck.length === 0);
  $("#burned-count").textContent = state.burnedCount;

  const dz = $("#discard-zone");
  dz.replaceChildren();
  if (state.pile.length === 0) {
    const e = document.createElement("div");
    e.className = "discard-empty"; e.textContent = "Pile";
    dz.appendChild(e);
  } else {
    // show up to the last 3 cards fanned, top card prominent
    const tail = state.pile.slice(-3);
    tail.forEach((c, i) => {
      const el = renderCard(c, { className: "discard-card" });
      el.style.setProperty("--i", i - tail.length + 1);
      dz.appendChild(el);
    });
    const badge = document.createElement("span");
    badge.className = "pile-count"; badge.textContent = state.pile.length;
    dz.appendChild(badge);
  }

  const hint = $("#req-hint");
  if (!myTurn) { hint.textContent = ""; return; }
  if (summ && summ.underAttack) {
    hint.textContent = summ.mustPickup
      ? "Joker played — no 3 to deflect, pick up the pile"
      : "Joker played — play a 3 to pass it on, or pick up the pile";
    return;
  }
  const req = requirement(state.pile, state.options);
  const cc = comparisonCard(state.pile, state.options);
  if (req.kind === "free") hint.textContent = "Play any card";
  else if (req.kind === "max7") hint.textContent = "Play a 7 or lower (or a power card)";
  else hint.textContent = `Beat ${cc.rank}${SUIT_GLYPH[cc.suit]} — play equal or higher`;
}

function renderHand(viewer, myTurn, zone, summ) {
  // hand — skip the rebuild while a drag is live (the lifted node lives in
  // <body>); onDragEnd flushes the deferred render once the drag tears down.
  const hHost = $("#you-hand");
  if (document.body.classList.contains("hand-dragging")) {
    ui.pendingHandRender = true;
    return;
  }
  hHost.replaceChildren();
  orderedHand(viewer).forEach((c) => {
    const el = makeSelectableCard(c, "hand", myTurn && zone === "hand", summ);
    el.classList.add("in-hand");
    if (myTurn && zone === "hand" && !summ.ranks.includes(c.rank)) el.classList.add("dim");
    hHost.appendChild(el);
  });
  layoutHand(hHost);
}

function makeSelectableCard(c, zoneName, active, summ) {
  const el = renderCard(c, {});
  if (active) {
    el.classList.add("selectable");
    bindSelect(el, c.id, zoneName, summ);
    if (ui.selected.includes(c.id)) el.classList.add("selected");
  }
  return el;
}

// The viewer's hand in the order they arranged it (via drag-reorder). Cards
// drawn or picked up are appended in engine order; removed cards drop out.
function orderedHand(viewer) {
  const byCardId = new Map(viewer.hand.map((c) => [c.id, c]));
  const prev = ui.handOrders[viewer.id] || [];
  const order = prev.filter((id) => byCardId.has(id));
  const have = new Set(order);
  for (const c of viewer.hand) if (!have.has(c.id)) order.push(c.id);
  ui.handOrders[viewer.id] = order;
  return order.map((id) => byCardId.get(id));
}

function bindSelect(el, id, zoneName, summ) {
  el.addEventListener("click", () => toggleSelect(id, zoneName, summ));
}

function toggleSelect(id, zoneName, summ) {
  const viewer = byId(ui.viewerId);
  const card = [...viewer.hand, ...viewer.faceUp].find((c) => c.id === id);
  if (!card) return;
  if (summ && !summ.ranks.includes(card.rank)) { toast("You can't play that on the pile."); return; }
  const selRank = ui.selected.length ? cardRank(viewer, ui.selected[0]) : null;

  if (prefs.selectMatching) {
    // Tap grabs (or releases) every same-number card in this zone — suit is
    // irrelevant, only the number matters for laying a set together.
    if (selRank === card.rank) {
      ui.selected = [];
    } else {
      const zoneCards = viewer[zoneName] || [];
      ui.selected = zoneCards.filter((c) => c.rank === card.rank).map((c) => c.id);
    }
  } else if (ui.selected.includes(id)) {
    ui.selected = ui.selected.filter((x) => x !== id);
  } else {
    if (selRank && selRank !== card.rank) ui.selected = [id]; // switch to new rank
    else ui.selected.push(id);
  }
  renderPlay();
}
function cardRank(viewer, id) {
  const c = [...viewer.hand, ...viewer.faceUp].find((x) => x.id === id);
  return c ? c.rank : null;
}

function renderActions(viewer, myTurn, zone, summ) {
  const playBtn = $("#play-btn");
  const pickBtn = $("#pickup-btn");
  const info = $("#sel-info");
  const canAct = myTurn && !viewer.isCPU;
  // Empty hand + face-up cards left → the only move is to take them in.
  const takeOnly = canAct && summ && summ.canTakeFaceUp && zone === "faceUp";
  playBtn.disabled = !(canAct && !takeOnly && zone !== "faceDown" && ui.selected.length > 0);
  pickBtn.disabled = !(canAct && !takeOnly && zone !== "faceDown" && state.pile.length > 0);
  pickBtn.hidden = !canAct || takeOnly;
  playBtn.hidden = !canAct || takeOnly || zone === "faceDown";
  const matchRow = $("#match-row");
  if (matchRow) matchRow.hidden = !(canAct && !takeOnly && zone !== "faceDown");

  if (!canAct) { info.textContent = ""; return; }
  if (takeOnly) info.textContent = "Tap your face-up cards to take them into your hand";
  else if (summ && summ.underAttack && summ.mustPickup) info.textContent = "No 3 — pick up the pile";
  else if (zone === "faceDown") info.textContent = "Tap a face-down card to flip it";
  else if (summ && summ.canTakeFaceUp) info.textContent = "Play a card, or tap a face-up card to take it in";
  else if (ui.selected.length) {
    const r = cardRank(viewer, ui.selected[0]);
    info.textContent = `${ui.selected.length}× ${r}`;
  } else if (summ.mustPickup) info.textContent = "No legal play — pick up the pile";
  else info.textContent = "Select a card to play";
}

// Lay out the hand in one of two modes (mirrors Benny):
//   fanned: heavy overlap + per-card tilt around a pivot below the row, so the
//           cards look held in a real hand.
//   spread: minimal gap; overlap only as much as needed to fit the width.
// Either way the left strip of every card stays visible so its top-left
// rank+suit is always readable; the container overlap goes into --hand-overlap
// and per-card tilt into --card-rot (both consumed by CSS).
function layoutHand(host) {
  host = host || $("#you-hand");
  if (!host) return;
  const cards = $$(".card", host);
  const n = cards.length;
  host.classList.toggle("fanned", prefs.handFanned !== false);
  cards.forEach((c) => c.style.removeProperty("--card-rot"));
  if (n === 0) { host.style.setProperty("--hand-overlap", "4px"); return; }

  const cardW = cards[0].offsetWidth || 70;
  const dock = host.parentElement || host;
  const available = Math.max(0, (dock.clientWidth || window.innerWidth) - 16);
  // Never cover more than ~70% of a card, so its top-left corner always shows.
  const minVisible = Math.max(18, Math.round(cardW * 0.30));

  if (prefs.handFanned !== false) {
    // Each card fans around a pivot 240% below it (transform-origin in CSS), so
    // the edge cards' top corners swing well past their own box. Account for
    // that swing when fitting the row, or the rotated rank corners of the end
    // cards clip off the dock edge (Benny's mechanic).
    const cardH = cards[0].offsetHeight || (cardW * 1.553);
    const pivotY = 2.4 * cardH;
    const swingFor = (deg) => {
      const r = (deg * Math.PI) / 180;
      return (cardW / 2) * (1 - Math.cos(r)) + pivotY * Math.sin(r);
    };
    let stepDeg = n > 1 ? Math.min(4, 22 / (n - 1)) : 0;
    let edgeDeg = stepDeg * (n - 1) / 2;
    const minStep = Math.max(1, Math.round(cardW * 0.10));
    let overlap = -Math.round(cardW * 0.45);             // show ~55% of each card
    if (n > 1 && available > 0) {
      const budget = Math.max(0, available - 2 * swingFor(edgeDeg));
      const fannedWidth = cardW + (n - 1) * (cardW + overlap);
      if (fannedWidth > budget) {
        const step = (budget - cardW) / (n - 1);
        if (step >= minStep) {
          overlap = step - cardW;
        } else {
          // Min overlap still overflows — pull the tilt in so the corners stay
          // on-screen. Flatter fan, but no clipped ranks.
          overlap = minStep - cardW;
          const tightWidth = cardW + (n - 1) * (cardW + overlap);
          const swingBudget = Math.max(0, (available - tightWidth) / 2);
          if (swingBudget <= 0 || pivotY <= 0) edgeDeg = 0;
          else edgeDeg = Math.min(edgeDeg, (Math.asin(Math.min(1, swingBudget / pivotY)) * 180) / Math.PI);
          stepDeg = n > 1 ? (2 * edgeDeg) / (n - 1) : 0;
        }
      }
    }
    host.style.setProperty("--hand-overlap", `${Math.round(overlap)}px`);
    const startDeg = -edgeDeg;
    cards.forEach((c, i) => c.style.setProperty("--card-rot", `${(startDeg + stepDeg * i).toFixed(2)}deg`));
    return;
  }

  // Spread — pack to width only if the natural layout doesn't fit.
  const gap = 4;
  const naturalWidth = n * cardW + (n - 1) * gap;
  if (n === 1 || naturalWidth <= available) { host.style.setProperty("--hand-overlap", `${gap}px`); return; }
  let overlap = (available - cardW) / (n - 1) - cardW;
  if (cardW + overlap < minVisible) overlap = minVisible - cardW;
  host.style.setProperty("--hand-overlap", `${Math.round(overlap)}px`);
}

// ---------------------------------------------------------------- hand drag/drop
// Reorder the hand by dragging, or drag a card onto the discard pile to play it.
// Reuses the same pointer-event module as Benny (reparent-to-body + placeholder
// + deferred render) so the drag survives mid-render rebuilds without ghosting.
let handDragWired = false;
function setupHandDrag() {
  if (handDragWired) return;
  handDragWired = true;
  makeHandReorderable(
    $("#you-hand"),
    (from, to) => {
      const order = ui.handOrders[ui.viewerId];
      if (!order || from < 0 || to < 0 || from >= order.length) { renderPlay(); return; }
      const [moved] = order.splice(from, 1);
      order.splice(Math.max(0, Math.min(order.length, to)), 0, moved);
      renderPlay();
    },
    {
      resolveDropTarget: (x, y) => {
        const dz = $("#discard-zone");
        if (!dz) return null;
        const r = dz.getBoundingClientRect();
        const pad = 44;        // forgiving hit area — the pile sits up in the centre now
        if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) {
          return { el: dz, kind: "discard" };
        }
        return null;
      },
      onDropOnTarget: (target, cardEl) => { if (target.kind === "discard") dropPlay(cardEl.dataset.cardId); },
      onPlaceholderMove: () => layoutHand($("#you-hand")),
      onDragEnd: () => { if (ui.pendingHandRender) { ui.pendingHandRender = false; renderPlay(); } },
    },
  );
}

// A card was dragged onto the discard pile — play it (or its matching set).
function dropPlay(id) {
  if (!state || state.phase !== "play") { renderPlay(); return; }
  const cur = state.players[state.current];
  const viewer = byId(ui.viewerId);
  if (!cur || !viewer || cur.id !== viewer.id || cur.isCPU || currentZone(cur) !== "hand") { renderPlay(); return; }
  const card = viewer.hand.find((c) => c.id === id);
  const summ = legalSummary(state);
  if (!card || !summ.ranks.includes(card.rank)) { toast("You can't play that on the pile."); renderPlay(); return; }
  let cardIds;
  if (ui.selected.length && ui.selected.includes(id) && cardRank(viewer, ui.selected[0]) === card.rank) {
    cardIds = ui.selected.slice();                                  // play the chosen set
  } else if (prefs.selectMatching) {
    cardIds = viewer.hand.filter((c) => c.rank === card.rank).map((c) => c.id); // grab matching number
  } else {
    cardIds = [id];
  }
  ui.selected = [];
  doAction({ type: "play", playerId: cur.id, source: "hand", cardIds });
}

// ---------------------------------------------------------------- summary tracking
function trackEvent() {
  const e = state.lastEvent;
  if (!e || !e.playerId) return;
  const s = ui.summaries[e.playerId];
  if (!s) return; // not a tracked human
  if (e.type === "play") {
    const tens = e.cards.filter((c) => c.rank === "10").length;
    const twos = e.cards.filter((c) => c.rank === "2").length;
    s.tens += tens; s.twos += twos;
    if (e.joker) s.jokers += e.cards.length;
    if (e.deflect) s.deflects += 1;
    if (e.burned) { s.burns += 1; if (tens === 0) s.fourKinds += 1; }
    if (e.finished && e.wasBlind) s.wonOnBlind = true;
  } else if (e.type === "pickup" || e.type === "blindFail") {
    s.pickups += 1; s.maxPickup = Math.max(s.maxPickup, e.count || 0);
  }
}

// ---------------------------------------------------------------- game over
function endMatch() {
  showScreen("screen-over");
  const shithead = byId(state.shitheadId);
  $("#over-title").textContent = shithead
    ? `${shithead.id === ui.humanId ? "You are" : shithead.name + " is"} the Sh!thead! 💩`
    : "Game over";

  // standings: finishOrder then the shithead last
  const order = state.finishOrder.map((id) => byId(id));
  const loser = byId(state.shitheadId);
  if (loser && !order.includes(loser)) order.push(loser);
  const results = $("#results"); results.replaceChildren();
  order.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "result-row" + (p.id === state.shitheadId ? " loser" : "") + (i === 0 ? " winner" : "");
    const place = p.id === state.shitheadId ? "💩" : medal(i + 1);
    row.innerHTML = `<span class="rplace">${place}</span><span class="rname">${escapeHtml(p.name)}</span>` +
      `<span class="rtag">${p.id === state.shitheadId ? "Sh!thead" : i === 0 ? "Winner!" : "#" + (i + 1)}</span>`;
    results.appendChild(row);
  });

  // record stats + achievements for every human
  const total = state.players.length;
  const earnedHost = $("#earned"); earnedHost.replaceChildren();
  for (const id of ui.humans) {
    const p = byId(id);
    const isShit = id === state.shitheadId;
    recordMatch(p.name, { place: p.place, isShithead: isShit, total, mode });
    const s = ui.summaries[id];
    s.place = p.place; s.isShithead = isShit; s.total = total;
    accrueProgress(p.name, s);
    const earnedIds = evaluate(s);
    const fresh = addAchievements(p.name, earnedIds);
    if (fresh.length && (mode === "cpu" || id === ui.viewerId || ui.humans.length === 1)) {
      for (const aid of fresh) {
        const a = achievementById(aid);
        if (a) earnedHost.appendChild(renderAchievementCard(a, true));
      }
    }
  }
  if (earnedHost.children.length) {
    const h = document.createElement("h3"); h.textContent = "Achievements unlocked";
    earnedHost.prepend(h);
  }
  storage.clear(mode);
}

function medal(n) { return n === 1 ? "🥇" : n === 2 ? "🥈" : n === 3 ? "🥉" : "#" + n; }

function wireOver() {
  $("#rematch-btn").addEventListener("click", () => startNewGame());
  $("#over-home-btn").addEventListener("click", () => { state = null; renderSaved(); showScreen("screen-start"); });
}

// ---------------------------------------------------------------- persistence / resume
function persist() {
  if (!state || ui.ephemeral) return;   // practice/tutorial games aren't saved
  storage.save({ mode, state: serialize(state), ui: { humanId: ui.humanId, humans: ui.humans, viewerId: ui.viewerId, summaries: ui.summaries } });
}

const MODE_LABEL = { cpu: "Solo vs CPU", local: "Pass & Play" };
function renderSaved() {
  const list = $("#saved-list");
  const section = $("#saved-section");
  if (!list || !section) return;
  const saves = storage.loadAll();          // { cpu?: snap, local?: snap }
  const modes = Object.keys(saves);
  list.replaceChildren();
  if (!modes.length) { section.hidden = true; return; }
  section.hidden = false;
  for (const m of modes) {
    const snap = saves[m];
    const row = document.createElement("div");
    row.className = "saved-row"; row.dataset.mode = m;
    row.innerHTML =
      `<div class="saved-meta"><b>${escapeHtml(MODE_LABEL[m] || m)}</b>` +
      `<span class="muted">${escapeHtml(timeAgo(snap.savedAt))}</span></div>` +
      `<div class="saved-actions">` +
      `<button class="btn small primary" data-act="resume">Resume</button>` +
      `<button class="btn small ghost" data-act="discard">Discard</button></div>`;
    list.appendChild(row);
  }
}

// Resume a specific saved mode from the saved-games list — switch the active
// mode (and its setup tab) to match, then load its snapshot.
function resumeMode(m) {
  mode = m;
  $$(".mode-tile").forEach((t) => t.classList.toggle("active", t.dataset.mode === m));
  const off = $("#setup-offline"), on = $("#setup-online"), diff = $("#field-difficulty");
  if (off) off.hidden = mode === "online";
  if (on) on.hidden = mode !== "online";
  if (diff) diff.hidden = mode !== "cpu";
  onResume();
}

function onResume() {
  const snap = storage.load(mode);
  if (!snap) return;
  state = snap.state;
  ui.humanId = snap.ui.humanId;
  ui.humans = snap.ui.humans || [ui.humanId];
  ui.summaries = snap.ui.summaries || {};
  for (const id of ui.humans) if (!ui.summaries[id]) ui.summaries[id] = { ...emptySummary(), total: state.players.length };
  ui.selected = [];
  ui.handOrders = {};
  ui.toastedAch = new Set();
  ui.ephemeral = false;
  if (state.phase === "swap") { swapQueue = ui.humans.filter((id) => !byId(id).ready); nextSwap(); }
  else if (state.phase === "over") { enterPlay(); }
  else { enterPlay(); }
}

function exitToStart() {
  clearTimeout(ui.cpuTimer);
  persist();
  state = null;
  renderSaved();
  showScreen("screen-start");
}

// ---------------------------------------------------------------- pass-device overlay
function showPass(name, cb) {
  showBanner(`<div class="pass-card"><h2>Pass to ${escapeHtml(name)}</h2><p>Hand the device over, then tap when ${escapeHtml(name)} is ready.</p><button class="btn primary big" id="pass-go">${escapeHtml(name)} is ready</button></div>`, true);
  $("#pass-go").addEventListener("click", () => { hideBanner(); cb(); });
}

// ---------------------------------------------------------------- settings
function setCardSize(v) {
  prefs.cardSize = v;
  document.documentElement.dataset.cardSize = v;
  segSelect("#seg-cardsize", "sz", v);
  segSelect("#seg-cardsize-menu", "sz", v);
  savePrefs();
  if (state) renderPlay();
}
function setFan(on) {
  prefs.handFanned = !!on;
  savePrefs();
  const fan = $("#opt-fan"); if (fan) fan.checked = !!on;
  syncFanLabel();
  if (state) layoutHand($("#you-hand"));
}
function syncFanLabel() {
  const btn = $("#menu-fan");
  if (!btn) return;
  btn.textContent = prefs.handFanned !== false ? "Fan your hand: On" : "Fan your hand: Off";
  btn.setAttribute("aria-pressed", String(prefs.handFanned !== false));
}

function wireSettings() {
  wireSeg("#seg-cardstyle", "cs", (v) => { prefs.cardStyle = v; setCardStyle(v); savePrefs(); if (state) renderPlay(); });
  wireSeg("#seg-cardsize", "sz", setCardSize);
  wireSeg("#seg-cardsize-menu", "sz", setCardSize);
  $("#opt-animate").addEventListener("change", (e) => { prefs.animate = e.target.checked; savePrefs(); });
  $("#opt-fan").addEventListener("change", (e) => setFan(e.target.checked));
}

// ---- running-version stamp (start-screen footer). Keep APP_BUILD in sync with
// CACHE in sw.js; if the active SW cache key disagrees, flag the stale build.
const APP_BUILD = "v15";
function formatBuild(ver) {
  const n = String(ver).replace(/^v/i, "").padStart(3, "0");
  return "v." + n.split("").join(".");
}
async function renderVersionStamp() {
  const el = $("#app-version");
  if (!el) return;
  let cacheVer = null;
  try {
    if (globalThis.caches) {
      const keys = await caches.keys();
      const k = keys.find((x) => x.startsWith("shithead-"));
      if (k) cacheVer = k.replace(/^shithead-/, "");
    }
  } catch (_) { /* caches unavailable (private mode) — show the build only */ }
  if (cacheVer && cacheVer !== APP_BUILD) {
    el.textContent = `Sh!thead ${formatBuild(APP_BUILD)} · cache ${formatBuild(cacheVer)} — refresh to update`;
    el.classList.add("stale");
  } else {
    el.textContent = `Sh!thead ${formatBuild(APP_BUILD)}`;
    el.classList.remove("stale");
  }
}

// ---------------------------------------------------------------- stats modal
// A single achievement tile: icon + name + description, dimmed when locked.
function renderAchievementCard(a, unlocked) {
  const el = document.createElement("div");
  el.className = `achievement-card ${unlocked ? "is-unlocked" : "is-locked"}`;
  el.innerHTML =
    `<div class="achievement-icon" aria-hidden="true">${a.icon || "🏆"}</div>` +
    `<div class="achievement-info">` +
    `<div class="achievement-name">${escapeHtml(a.name)}</div>` +
    `<div class="achievement-desc">${escapeHtml(a.desc)}</div></div>`;
  return el;
}
function achievementsGrid(unlockedIds) {
  const grid = document.createElement("div");
  grid.className = "achievements-grid";
  const set = new Set(unlockedIds || []);
  for (const a of ACHIEVEMENTS) grid.appendChild(renderAchievementCard(a, set.has(a.id)));
  return grid;
}

// A lifetime "goal" tile with a progress bar.
function renderProgressCard(item) {
  const { def, value, target, unlocked } = item;
  const pct = Math.round((value / target) * 100);
  const el = document.createElement("div");
  el.className = `achievement-card has-progress ${unlocked ? "is-unlocked" : ""}`;
  el.innerHTML =
    `<div class="achievement-icon" aria-hidden="true">${def.icon || "🏆"}</div>` +
    `<div class="achievement-info">` +
    `<div class="achievement-name">${escapeHtml(def.name)}</div>` +
    `<div class="achievement-desc">${escapeHtml(def.desc)}</div>` +
    `<div class="ach-progress"><div class="ach-progress-track"><div class="ach-progress-fill" style="width:${pct}%"></div></div>` +
    `<span class="ach-progress-label">${value} / ${target}</span></div></div>`;
  return el;
}
function progressGrid(profile) {
  const grid = document.createElement("div");
  grid.className = "achievements-grid";
  const items = profile ? evaluateProgress(profile)
    : PROGRESS_ACHIEVEMENTS.map((def) => ({ def, value: 0, target: def.target, unlocked: false }));
  for (const item of items) grid.appendChild(renderProgressCard(item));
  return grid;
}

// Recent-results sparkline: one bar per game, taller = better finish, coloured
// gold (win) / grey (mid) / red (Sh!thead). Newest on the right.
function renderSparkline(history) {
  const games = (history || []).slice(0, 18).reverse();
  const wrap = document.createElement("div");
  wrap.className = "spark";
  for (const g of games) {
    const perf = g.total > 1 ? (g.total - g.place) / (g.total - 1) : (g.place === 1 ? 1 : 0);
    const bar = document.createElement("span");
    bar.className = "spark-bar " + (g.isShithead ? "shit" : g.place === 1 ? "win" : "mid");
    bar.style.height = `${Math.round(8 + perf * 26)}px`;
    bar.title = g.isShithead ? "Sh!thead" : `#${g.place} of ${g.total}`;
    wrap.appendChild(bar);
  }
  return wrap;
}
function sectionTitle(text) {
  const h = document.createElement("div");
  h.className = "ach-section-title"; h.textContent = text;
  return h;
}

const profKey = (name) => String(name || "").trim().toLowerCase();
const lastSeen = (p) => (p.history && p.history[0] && p.history[0].at) || 0;

// Render one player's stats panel into #stats-body (null → the "nothing yet"
// placeholder showing everything still to unlock).
function renderStatsBody(prof) {
  const body = $("#stats-body");
  body.replaceChildren();
  if (!prof) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "No games played yet — here's everything there is to unlock:";
    body.appendChild(note);
    body.appendChild(sectionTitle("Achievements"));
    body.appendChild(achievementsGrid([]));
    body.appendChild(sectionTitle("Lifetime goals"));
    body.appendChild(progressGrid(null));
    return;
  }
  const s = prof.stats;
  const div = document.createElement("div");
  div.className = "stat-card";
  div.innerHTML = `<div class="stat-grid">
      <span>Games</span><b>${s.games}</b>
      <span>Wins</span><b>${s.wins}</b>
      <span>Sh!thead</span><b>${s.shitheads}</b>
      <span>Best streak</span><b>${s.bestStreak}</b>
    </div>
    <div class="ach-count">${prof.achievements.length} / ${ACHIEVEMENTS.length} achievements unlocked</div>`;
  if (prof.history && prof.history.length) {
    div.appendChild(sectionTitle("Recent games"));
    div.appendChild(renderSparkline(prof.history));
  }
  div.appendChild(sectionTitle("Achievements"));
  div.appendChild(achievementsGrid(prof.achievements));
  div.appendChild(sectionTitle("Lifetime goals"));
  div.appendChild(progressGrid(prof));
  body.appendChild(div);
}

function openStats() {
  // Most-recently-played first; default to the device owner if they have a record.
  const profiles = listProfiles().slice().sort((a, b) => lastSeen(b) - lastSeen(a));
  const field = $("#stats-player-field");
  const picker = $("#stats-player");
  if (!profiles.length) {
    field.hidden = true;
    renderStatsBody(null);
    openModal("modal-stats");
    return;
  }
  field.hidden = false;
  picker.replaceChildren();
  for (const p of profiles) {
    const opt = document.createElement("option");
    opt.value = profKey(p.name);
    opt.textContent = p.name;
    picker.appendChild(opt);
  }
  const ownerKey = profKey(prefs.name);
  picker.value = profiles.some((p) => profKey(p.name) === ownerKey) ? ownerKey : profKey(profiles[0].name);
  renderStatsBody(profiles.find((p) => profKey(p.name) === picker.value) || profiles[0]);
  openModal("modal-stats");
}

// Re-render when a different player is chosen from the dropdown.
function onStatsPlayerChange() {
  const key = $("#stats-player").value;
  const prof = listProfiles().find((p) => profKey(p.name) === key) || null;
  renderStatsBody(prof);
}

// ---------------------------------------------------------------- how to play
function renderHowto() {
  $("#howto-body").innerHTML = `
    <p><b>Goal:</b> get rid of all your cards. The last player still holding cards is the <b>Sh!thead</b>.</p>
    <p><b>Each turn</b> play a card equal to or higher than the top of the pile, then draw back up to 3 (while the deck lasts). Play several at once if they're the same rank. Can't (or won't) play? <b>Pick up the whole pile.</b></p>
    <p><b>Card order:</b> 3 (low) → 4 → 5 → 6 → 7 → 8 → 9 → J → Q → K → A (high).</p>
    <p><b>Power cards</b> (each can be switched on or off in House rules)</p>
    <ul>
      <li><b>2</b> — Reset. Play on anything; the next player can play anything.</li>
      <li><b>10</b> — Burn. Play on anything; the pile is removed and you go again.</li>
      <li><b>7</b> — The next player must play a 7 or lower.</li>
      <li><b>8</b> — <b>Reverse</b> the direction of play (with two players it bounces back, so you go again), <i>or</i> Invisible (see through to the card below), <i>or</i> Skip the next player — depending on house rules.</li>
      <li><b>Joker</b> — the next player must pick up the <i>whole pile</i>… unless they play a <b>3</b>, which passes that fate to the player after them, and so on until someone without a 3 scoops it all.</li>
      <li><b>Four of a kind</b> on the pile burns it — same as a 10.</li>
    </ul>
    <p><b>Endgame:</b> once your hand is empty, play your 3 face-up cards. Then play your 3 face-down cards <b>blind</b> — flip one; if it beats the pile it stays, otherwise you take the pile.</p>`;
}

// ---------------------------------------------------------------- tutorial
// A guided coach overlay running on a throwaway practice game (vs one easy
// bot). The bots are paused while the coach talks; each step spotlights a real
// UI element with a short explanation. Nothing is scripted — when it ends, the
// practice game is yours to play.
const TUTORIAL_STEPS = [
  { target: null, title: "Welcome to Sh!thead!", body: "The goal: be the first to get rid of all your cards. Whoever's left holding cards is the Sh!thead." },
  { target: "#you-hand", title: "Your hand", body: "These are your cards. On your turn, play a card equal to or higher than the top of the pile — or several of the same number at once." },
  { target: "#discard-zone", title: "The pile", body: "Play onto the pile here: tap a card then Play, or just drag a card onto the pile. The next player has to beat your top card." },
  { target: "#deck-stack", title: "Draw pile", body: "After playing from your hand you draw back up to three cards — while the deck lasts. So your hand stays at three until it runs out." },
  { target: "#pickup-btn", title: "Stuck?", body: "Can't (or don't want to) play? Pick up the whole pile into your hand — then it's the next player's go." },
  { target: null, title: "Power cards", body: "Look out for power cards: 2 resets the pile, 10 burns it, 7 forces a low play, 8 reverses the order, and a Joker makes the next player scoop everything. Toggle them in House rules." },
  { target: "#player-rows", title: "The table", body: "Every player's table sits here — face-up cards over face-down. When your hand empties, tap your face-up cards into your hand and play them. The three face-down cards are last, played blind!" },
  { target: null, title: "You're ready!", body: "That's the gist. This is a practice game against an easy bot — have a go. Good luck, and don't be the Sh!thead!" },
];

let coachEl = null, coachIdx = 0;

function startTutorial() {
  closeModals();
  hideBanner();
  ui.tutorialActive = true;
  ui.ephemeral = true;                 // a throwaway game — never saved
  mode = "cpu";
  const players = [
    { id: "you", name: defaultName(0), isCPU: false, difficulty: "normal" },
    { id: "cpu1", name: "Coach", isCPU: true, difficulty: "easy" },
  ];
  const options = {
    swapPhase: false, jokers: false, sevenPower: false, eightMode: "reverse",
    twoPower: true, tenPower: true, fourKindAcrossTurns: true, replayOnBurn: true,
  };
  state = createState({ players, options });
  state.current = 0;                   // make it the human's turn so the controls show
  ui.humans = ["you"]; ui.humanId = "you";
  ui.handOrders = {}; ui.toastedAch = new Set();
  ui.summaries = { you: { ...emptySummary(), difficulty: "easy", total: 2 } };
  enterPlay();                         // CPUs are gated by ui.tutorialActive
  coachStep(0);
}

function buildCoach() {
  coachEl = document.createElement("div");
  coachEl.id = "coach";
  coachEl.innerHTML =
    `<div class="coach-block"></div>` +
    `<div class="coach-spot"></div>` +
    `<div class="coach-balloon"><div class="coach-step"></div>` +
    `<div class="coach-title"></div><div class="coach-body"></div>` +
    `<div class="coach-actions"><button class="link coach-skip">Skip tour</button>` +
    `<button class="btn primary coach-next">Next</button></div></div>`;
  document.body.appendChild(coachEl);
  coachEl.querySelector(".coach-next").addEventListener("click", () => {
    if (coachIdx >= TUTORIAL_STEPS.length - 1) endTutorial();
    else coachStep(coachIdx + 1);
  });
  coachEl.querySelector(".coach-skip").addEventListener("click", skipTutorial);
}

function coachStep(i) {
  coachIdx = i;
  if (!coachEl) buildCoach();
  const step = TUTORIAL_STEPS[i];
  const last = i === TUTORIAL_STEPS.length - 1;
  const spot = coachEl.querySelector(".coach-spot");
  const balloon = coachEl.querySelector(".coach-balloon");
  coachEl.querySelector(".coach-step").textContent = `Step ${i + 1} of ${TUTORIAL_STEPS.length}`;
  coachEl.querySelector(".coach-title").textContent = step.title;
  coachEl.querySelector(".coach-body").textContent = step.body;
  coachEl.querySelector(".coach-next").textContent = last ? "Let's play!" : "Next";

  const tgt = step.target ? $(step.target) : null;
  const r = tgt && tgt.getBoundingClientRect ? tgt.getBoundingClientRect() : null;
  if (r && r.width > 0 && r.height > 0) {
    const pad = 8;
    spot.style.display = "block";
    spot.style.left = `${r.left - pad}px`;
    spot.style.top = `${r.top - pad}px`;
    spot.style.width = `${r.width + pad * 2}px`;
    spot.style.height = `${r.height + pad * 2}px`;
    balloon.classList.remove("vcenter");
    if (r.top < window.innerHeight * 0.5) {
      balloon.style.top = `${Math.min(r.bottom + 14, window.innerHeight - 200)}px`;
      balloon.style.bottom = "auto";
    } else {
      balloon.style.bottom = `${window.innerHeight - r.top + 14}px`;
      balloon.style.top = "auto";
    }
  } else {
    spot.style.display = "none";
    balloon.classList.add("vcenter");
    balloon.style.top = ""; balloon.style.bottom = "";
  }
}

function removeCoach() { if (coachEl) { coachEl.remove(); coachEl = null; } }

function endTutorial() {
  ui.tutorialActive = false;
  prefs.tutorialDone = true; savePrefs();
  removeCoach();
  renderTourOffer();
  if (state && state.phase === "play") scheduleTurn();   // hand control back / wake the bot
}

function skipTutorial() {
  ui.tutorialActive = false;
  ui.ephemeral = false;
  prefs.tutorialDone = true; savePrefs();
  removeCoach();
  clearTimeout(ui.cpuTimer);
  state = null;
  renderTourOffer();
  renderSaved();
  showScreen("screen-start");
}

// First-run "take the tour" offer on the home screen + the footer control,
// which toggles label/role depending on whether the offer has been dismissed.
function renderTourOffer() {
  const offer = $("#tour-offer");
  if (offer) offer.hidden = !!prefs.tutorialDone;
  const foot = $("#tutorial-foot");
  if (foot) foot.textContent = prefs.tutorialDone ? "Replay tutorial" : "Dismiss tutorial";
}

// ---------------------------------------------------------------- modals
function wireModals() {
  $$("[data-close-modal]").forEach((b) => b.addEventListener("click", closeModals));
  $$(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m && m.id !== "modal-welcome") closeModals(); }));
  $("#confirm-cancel").addEventListener("click", closeModals);
  $("#stats-player").addEventListener("change", onStatsPlayerChange);
}
function openModal(id) { $("#" + id).hidden = false; }
function closeModals() { $$(".modal").forEach((m) => m.hidden = true); }
function showConfirm(title, msg, onOk) {
  $("#confirm-title").textContent = title;
  $("#confirm-msg").textContent = msg;
  const ok = $("#confirm-ok");
  const fresh = ok.cloneNode(true); ok.replaceWith(fresh);
  fresh.addEventListener("click", () => { closeModals(); onOk(); });
  openModal("modal-confirm");
}

// ---------------------------------------------------------------- toast / banner
let toastTimer = null;
function toast(msg) {
  const host = $("#toast-host");
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2200);
}
function showBanner(html, blocking) {
  const host = $("#banner-host");
  host.innerHTML = `<div class="banner-inner">${html}</div>`;
  host.classList.toggle("blocking", !!blocking);
  host.classList.add("show");
}
function hideBanner() { $("#banner-host").classList.remove("show"); $("#banner-host").innerHTML = ""; }

// ---------------------------------------------------------------- util
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function timeAgo(ts) {
  const d = Date.now() - (ts || 0); const m = Math.round(d / 60000);
  if (m < 1) return "just now"; if (m < 60) return m + "m ago";
  const h = Math.round(m / 60); if (h < 24) return h + "h ago"; return Math.round(h / 24) + "d ago";
}

window.addEventListener("resize", () => { if (state && $("#screen-play").classList.contains("active")) layoutHand($("#you-hand")); });
boot();

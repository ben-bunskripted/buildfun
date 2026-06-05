// Sh!thead — UI controller. Screen routing, setup, swap phase, the play table,
// the CPU turn driver, and game-over → stats/achievements.

import { renderCard, renderCardBack, setCardStyle } from "./cards.js";
import {
  createState, applyAction, currentZone, legalSummary, serialize,
} from "./game.js";
import { comparisonCard, requirement, SUIT_GLYPH, value } from "./rules.js";
import { planTurn, planSwaps } from "./ai.js";
import * as storage from "./storage.js";
import { recordMatch, addAchievements, getProfile, listProfiles } from "./profiles.js";
import { evaluate, emptySummary, achievementById, ACHIEVEMENTS } from "./achievements.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const BOT_NAMES = ["Benny", "Ruby", "Coco", "Pip", "Ace", "Domino"];

let prefs = storage.loadPrefs();
let state = null;
let mode = "cpu";
const ui = {
  viewerId: null,   // whose cards we currently show
  humanId: null,    // the device owner in solo mode
  humans: [],       // ids of all human-controlled players
  selected: [],     // selected card ids in hand/face-up
  summaries: {},    // per-human achievement tally
  cpuTimer: null,
  busy: false,      // an action animation is in flight
  setup: { players: 3, difficulty: "normal", eightMode: "invisible", swap: true, fourkind: true, replay: true, seven: true },
};

// ---------------------------------------------------------------- boot
function boot() {
  applyPrefs();
  wireStart();
  wireSettings();
  wireModals();
  wirePlay();
  wireSwap();
  wireOver();
  renderHowto();
  renderResume();
  showScreen("screen-start");
}

function applyPrefs() {
  setCardStyle(prefs.cardStyle || "modern");
  document.documentElement.dataset.cardSize = prefs.cardSize || "m";
  if (prefs.animate === undefined) prefs.animate = true;
  // reflect into settings controls
  segSelect("#seg-cardstyle", "cs", prefs.cardStyle || "modern");
  segSelect("#seg-cardsize", "sz", prefs.cardSize || "m");
  const anim = $("#opt-animate"); if (anim) anim.checked = prefs.animate !== false;
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
  $$(".mode-tab").forEach((t) => t.addEventListener("click", () => {
    $$(".mode-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    mode = t.dataset.mode;
    $("#setup-offline").hidden = mode === "online";
    $("#setup-online").hidden = mode !== "online";
    $("#field-difficulty").hidden = mode !== "cpu";
    renderNames();
    renderResume();
  }));

  wireSeg("#seg-players", "n", (n) => { ui.setup.players = +n; renderNames(); });
  wireSeg("#seg-difficulty", "d", (d) => { ui.setup.difficulty = d; });
  wireSeg("#seg-eight", "e", (e) => { ui.setup.eightMode = e; });
  $("#opt-swap").addEventListener("change", (e) => ui.setup.swap = e.target.checked);
  $("#opt-fourkind").addEventListener("change", (e) => ui.setup.fourkind = e.target.checked);
  $("#opt-replay").addEventListener("change", (e) => ui.setup.replay = e.target.checked);
  $("#opt-seven").addEventListener("change", (e) => ui.setup.seven = e.target.checked);

  $("#start-btn").addEventListener("click", onDeal);
  $("#resume-btn").addEventListener("click", onResume);
  $("#howto-link").addEventListener("click", () => openModal("modal-howto"));
  $("#settings-link").addEventListener("click", () => openModal("modal-settings"));
  $("#stats-link").addEventListener("click", openStats);

  renderNames();
}

function renderNames() {
  const host = $("#player-names");
  host.replaceChildren();
  const n = ui.setup.players;
  if (mode === "cpu") {
    host.appendChild(nameInput("you", prefs.name || "You", true));
    const note = document.createElement("p");
    note.className = "cpu-note";
    note.textContent = `vs ${n - 1} CPU ${n - 1 === 1 ? "player" : "players"}`;
    host.appendChild(note);
  } else {
    for (let i = 0; i < n; i++) {
      host.appendChild(nameInput("p" + i, (prefs.localNames && prefs.localNames[i]) || `Player ${i + 1}`, true));
    }
  }
}
function nameInput(key, val, editable) {
  const wrap = document.createElement("label");
  wrap.className = "name-input";
  const input = document.createElement("input");
  input.type = "text"; input.maxLength = 16; input.value = val; input.dataset.key = key;
  if (!editable) input.disabled = true;
  wrap.appendChild(input);
  return wrap;
}

function collectSetup() {
  const inputs = $$("#player-names input");
  const names = inputs.map((i) => (i.value.trim() || i.placeholder || "Player"));
  const players = [];
  if (mode === "cpu") {
    const youName = names[0] || "You";
    prefs.name = youName; savePrefs();
    players.push({ id: "you", name: youName, isCPU: false, difficulty: "normal" });
    for (let i = 1; i < ui.setup.players; i++) {
      players.push({ id: "cpu" + i, name: BOT_NAMES[i - 1] || ("CPU " + i), isCPU: true, difficulty: ui.setup.difficulty });
    }
  } else {
    prefs.localNames = names; savePrefs();
    for (let i = 0; i < ui.setup.players; i++) {
      players.push({ id: "p" + i, name: names[i] || ("Player " + (i + 1)), isCPU: false, difficulty: "normal" });
    }
  }
  const options = {
    eightMode: ui.setup.eightMode,
    swapPhase: ui.setup.swap,
    fourKindAcrossTurns: ui.setup.fourkind,
    replayOnBurn: ui.setup.replay,
    sevenPower: ui.setup.seven,
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
  state = createState({ players, options });
  ui.humans = players.filter((p) => !p.isCPU).map((p) => p.id);
  ui.humanId = ui.humans[0];
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
  if (state.phase === "swap") {
    beginSwapQueue();
  } else {
    enterPlay();
  }
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
  $("#play-menu-btn").addEventListener("click", () => openModal("modal-menu"));
  $("#play-exit-btn").addEventListener("click", exitToStart);
  $("#menu-howto").addEventListener("click", () => { closeModals(); openModal("modal-howto"); });
  $("#menu-settings").addEventListener("click", () => { closeModals(); openModal("modal-settings"); });
  $("#menu-restart").addEventListener("click", () => { closeModals(); showConfirm("Restart game?", "Deal a fresh game with the same players?", () => startNewGame()); });
  $("#menu-quit").addEventListener("click", () => { closeModals(); exitToStart(); });
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
  persist();
  renderPlay();
  const wait = prefs.animate !== false ? 360 : 30;
  ui.cpuTimer = setTimeout(scheduleTurn, wait);
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
  else if (myTurn) pill.textContent = zone === "faceDown" ? "Flip a face-down card" : "Your turn";
  else pill.textContent = `${cur.name} is playing…`;
  pill.classList.toggle("yours", myTurn);

  renderOpponents(viewer);
  renderCenter(myTurn, summ);
  renderYou(viewer, myTurn, zone, summ);
  renderActions(viewer, myTurn, zone, summ);
}

function renderOpponents(viewer) {
  const host = $("#opponents");
  host.replaceChildren();
  const others = state.players.filter((p) => p.id !== viewer.id);
  for (const p of others) {
    const el = document.createElement("div");
    el.className = "opp";
    if (state.players[state.current].id === p.id && state.phase === "play") el.classList.add("active");
    if (p.finished) el.classList.add("finished");

    const head = document.createElement("div");
    head.className = "opp-head";
    head.innerHTML = `<span class="opp-name">${escapeHtml(p.name)}</span>` +
      (p.finished ? `<span class="badge done">#${p.place}</span>` : `<span class="opp-count">✋ ${p.hand.length}</span>`);
    el.appendChild(head);

    const table = document.createElement("div");
    table.className = "opp-table";
    // face-down backs
    for (let i = 0; i < p.faceDown.length; i++) {
      const stack = document.createElement("div");
      stack.className = "mini-stack";
      stack.appendChild(renderCardBack({ className: "mini" }));
      if (p.faceUp[i]) stack.appendChild(renderCard(p.faceUp[i], { className: "mini on-top" }));
      table.appendChild(stack);
    }
    // any face-up beyond face-down count
    for (let i = p.faceDown.length; i < p.faceUp.length; i++) {
      table.appendChild(renderCard(p.faceUp[i], { className: "mini" }));
    }
    el.appendChild(table);
    host.appendChild(el);
  }
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
  const req = requirement(state.pile, state.options);
  const cc = comparisonCard(state.pile, state.options);
  if (req.kind === "free") hint.textContent = "Play any card";
  else if (req.kind === "max7") hint.textContent = "Play a 7 or lower (or a power card)";
  else hint.textContent = `Beat ${cc.rank}${SUIT_GLYPH[cc.suit]} — play equal or higher`;
}

function renderYou(viewer, myTurn, zone, summ) {
  // face-down
  const fdHost = $("#you-facedown"); fdHost.replaceChildren();
  const blindActive = myTurn && zone === "faceDown";
  viewer.faceDown.forEach((c, i) => {
    const stack = document.createElement("div");
    stack.className = "mini-stack you-stack";
    const back = renderCardBack({ className: blindActive ? "selectable blind" : "" });
    if (blindActive) back.addEventListener("click", () => onBlindFlip(c.id));
    stack.appendChild(back);
    if (viewer.faceUp[i]) stack.appendChild(renderCard(viewer.faceUp[i], { className: "on-top" + (zone === "faceUp" && myTurn ? " selectable" : "") }));
    fdHost.appendChild(stack);
  });
  // any standalone face-up (when fewer face-down than face-up)
  const fuHost = $("#you-faceup"); fuHost.replaceChildren();
  if (viewer.faceDown.length === 0) {
    viewer.faceUp.forEach((c) => fuHost.appendChild(makeSelectableCard(c, "faceUp", myTurn && zone === "faceUp", summ)));
  }
  if (zone === "faceUp" && myTurn && viewer.faceDown.length > 0) {
    // face-up cards sit on top of the stacks; make those selectable
    $$("#you-facedown .on-top").forEach((el) => {
      const id = el.dataset.cardId;
      el.classList.add("selectable");
      bindSelect(el, id, "faceUp", summ);
      if (ui.selected.includes(id)) el.classList.add("selected");
    });
  }

  // hand
  const hHost = $("#you-hand"); hHost.replaceChildren();
  viewer.hand.forEach((c) => {
    const playable = myTurn && zone === "hand" && summ && summ.ranks.includes(c.rank);
    const el = makeSelectableCard(c, "hand", myTurn && zone === "hand", summ);
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

function bindSelect(el, id, zoneName, summ) {
  el.addEventListener("click", () => toggleSelect(id, zoneName, summ));
}

function toggleSelect(id, zoneName, summ) {
  const viewer = byId(ui.viewerId);
  const card = [...viewer.hand, ...viewer.faceUp].find((c) => c.id === id);
  if (!card) return;
  if (summ && !summ.ranks.includes(card.rank)) { toast("You can't play that on the pile."); return; }
  if (ui.selected.includes(id)) {
    ui.selected = ui.selected.filter((x) => x !== id);
  } else {
    const selRank = ui.selected.length ? cardRank(viewer, ui.selected[0]) : null;
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
  playBtn.disabled = !(canAct && zone !== "faceDown" && ui.selected.length > 0);
  pickBtn.disabled = !(canAct && zone !== "faceDown" && state.pile.length > 0);
  pickBtn.hidden = !canAct;
  playBtn.hidden = !canAct || zone === "faceDown";

  if (!canAct) { info.textContent = ""; return; }
  if (zone === "faceDown") info.textContent = "Tap a face-down card to flip it";
  else if (ui.selected.length) {
    const r = cardRank(viewer, ui.selected[0]);
    info.textContent = `${ui.selected.length}× ${r}`;
  } else if (summ.mustPickup) info.textContent = "No legal play — pick up the pile";
  else info.textContent = "Select a card to play";
}

// Fit the hand fan to the dock width — always compress so every card stays
// inside the viewport (a big pickup can balloon the hand to 20+ cards).
function layoutHand(host) {
  const cards = $$(".card", host);
  const n = cards.length;
  cards.forEach((c) => { c.style.marginLeft = ""; });
  if (n <= 1) return;
  const dockW = (host.parentElement.clientWidth || window.innerWidth) - 12;
  const cardW = cards[0].offsetWidth || 70;
  const total = n * cardW;
  if (total > dockW) {
    const maxOverlap = cardW - 6;                        // squeeze to a 6px sliver for huge hands
    const needed = (total - dockW) / (n - 1);
    const overlap = Math.max(0, Math.min(maxOverlap, needed));
    cards.forEach((c, i) => { if (i > 0) c.style.marginLeft = `-${overlap}px`; });
  }
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
    const earnedIds = evaluate(s);
    const fresh = addAchievements(p.name, earnedIds);
    if (fresh.length && (mode === "cpu" || id === ui.viewerId || ui.humans.length === 1)) {
      for (const aid of fresh) {
        const a = achievementById(aid);
        const chip = document.createElement("div");
        chip.className = "ach-chip";
        chip.innerHTML = `🏆 <b>${escapeHtml(a.name)}</b> — ${escapeHtml(a.desc)}`;
        earnedHost.appendChild(chip);
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
  $("#over-home-btn").addEventListener("click", () => { state = null; renderResume(); showScreen("screen-start"); });
}

// ---------------------------------------------------------------- persistence / resume
function persist() {
  if (!state) return;
  storage.save({ mode, state: serialize(state), ui: { humanId: ui.humanId, humans: ui.humans, viewerId: ui.viewerId, summaries: ui.summaries } });
}

function renderResume() {
  const snap = storage.load(mode);
  const banner = $("#resume-banner");
  if (!snap || mode === "online") { banner.hidden = true; return; }
  banner.hidden = false;
  const ago = timeAgo(snap.savedAt);
  $("#resume-text").textContent = `Resume your ${mode === "cpu" ? "solo" : "pass & play"} game · ${ago}`;
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
  if (state.phase === "swap") { swapQueue = ui.humans.filter((id) => !byId(id).ready); nextSwap(); }
  else if (state.phase === "over") { enterPlay(); }
  else { enterPlay(); }
}

function exitToStart() {
  clearTimeout(ui.cpuTimer);
  persist();
  state = null;
  renderResume();
  showScreen("screen-start");
}

// ---------------------------------------------------------------- pass-device overlay
function showPass(name, cb) {
  showBanner(`<div class="pass-card"><h2>Pass to ${escapeHtml(name)}</h2><p>Hand the device over, then tap when ${escapeHtml(name)} is ready.</p><button class="btn primary big" id="pass-go">${escapeHtml(name)} is ready</button></div>`, true);
  $("#pass-go").addEventListener("click", () => { hideBanner(); cb(); });
}

// ---------------------------------------------------------------- settings
function wireSettings() {
  wireSeg("#seg-cardstyle", "cs", (v) => { prefs.cardStyle = v; setCardStyle(v); savePrefs(); if (state) renderPlay(); });
  wireSeg("#seg-cardsize", "sz", (v) => { prefs.cardSize = v; document.documentElement.dataset.cardSize = v; savePrefs(); if (state) renderPlay(); });
  $("#opt-animate").addEventListener("change", (e) => { prefs.animate = e.target.checked; savePrefs(); });
  $("#menu-settings") && null;
}

// ---------------------------------------------------------------- stats modal
function openStats() {
  const body = $("#stats-body");
  const profiles = listProfiles();
  body.replaceChildren();
  if (!profiles.length) {
    body.innerHTML = `<p class="muted">No games played yet. Play a game to start tracking your stats and achievements.</p>`;
  } else {
    for (const prof of profiles) {
      const s = prof.stats;
      const div = document.createElement("div");
      div.className = "stat-card";
      div.innerHTML = `<h3>${escapeHtml(prof.name)}</h3>
        <div class="stat-grid">
          <span>Games</span><b>${s.games}</b>
          <span>Wins</span><b>${s.wins}</b>
          <span>Sh!thead</span><b>${s.shitheads}</b>
          <span>Best streak</span><b>${s.bestStreak}</b>
        </div>
        <div class="ach-list">${ACHIEVEMENTS.map((a) => `<span class="ach-pip ${prof.achievements.includes(a.id) ? "got" : ""}" title="${escapeHtml(a.name)}: ${escapeHtml(a.desc)}">🏆</span>`).join("")}</div>`;
      body.appendChild(div);
    }
  }
  openModal("modal-stats");
}

// ---------------------------------------------------------------- how to play
function renderHowto() {
  $("#howto-body").innerHTML = `
    <p><b>Goal:</b> get rid of all your cards. The last player still holding cards is the <b>Sh!thead</b>.</p>
    <p><b>Each turn</b> play a card equal to or higher than the top of the pile, then draw back up to 3 (while the deck lasts). Play several at once if they're the same rank. Can't (or won't) play? <b>Pick up the whole pile.</b></p>
    <p><b>Card order:</b> 3 (low) → 4 → 5 → 6 → 7 → 8 → 9 → J → Q → K → A (high).</p>
    <p><b>Power cards</b></p>
    <ul>
      <li><b>2</b> — Reset. Play on anything; the next player can play anything.</li>
      <li><b>10</b> — Burn. Play on anything; the pile is removed and you go again.</li>
      <li><b>7</b> — The next player must play a 7 or lower.</li>
      <li><b>8</b> — Invisible (see through to the card below) <i>or</i> Skip the next player, depending on house rules.</li>
      <li><b>Four of a kind</b> on the pile burns it — same as a 10.</li>
    </ul>
    <p><b>Endgame:</b> once your hand is empty, play your 3 face-up cards. Then play your 3 face-down cards <b>blind</b> — flip one; if it beats the pile it stays, otherwise you take the pile.</p>`;
}

// ---------------------------------------------------------------- modals
function wireModals() {
  $$("[data-close-modal]").forEach((b) => b.addEventListener("click", closeModals));
  $$(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) closeModals(); }));
  $("#confirm-cancel").addEventListener("click", closeModals);
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

// Benny online — session controller. Bridges net.js (transport) and main.js
// (state + renderers). main.js owns `state` and all DOM, so it hands us a small
// callback bundle; we own session orchestration, turn recording, and sync.

import * as net from "./net.js";
import { randomInt } from "./rng.js";
import {
  createMatch, startNextRound, serialize, hydrate,
  beginTurn, isMatchOver, advanceToNextRound,
} from "./game.js";

let cb = null;
// session: { roomId, name, mySeat, isHost, players[], lastSeq, status, started, recording }
let session = null;
let replaying = false;

export function init(callbacks) { cb = callbacks; }
export { net };

export function isInSession() { return !!session; }
export function isActive() { return !!session && session.started && session.status !== "finished"; }
export function mySeat() { return session ? session.mySeat : -1; }
export function isHost() { return !!session && session.isHost; }
export function roomId() { return session ? session.roomId : null; }
export function players() { return session ? session.players : []; }
export function isMyTurn() {
  const st = cb && cb.getState();
  return isActive() && st && st.currentPlayerIndex === session.mySeat;
}

// Append an action to the in-progress local turn (no-op unless it's my turn).
export function record(action) {
  if (session && Array.isArray(session.recording)) session.recording.push(action);
}

// ---- Lobby ----
export async function createRoom(opts) {
  const res = await net.createRoom(opts);
  enter(res, true);
  ensurePoll();
  return res;
}

export async function joinRoom(roomId, password, displayName) {
  const res = await net.joinRoom(roomId, password, displayName);
  enter(res, res.isHost);
  // If we joined a game already in progress, the next poll adopts + routes.
  ensurePoll();
  return res;
}

function enter(res, isHost) {
  session = {
    roomId: res.roomId, name: res.name, mySeat: res.seat, isHost,
    players: res.players || [], lastSeq: res.seq || 0,
    status: res.status || "lobby", started: false, recording: null,
  };
}

export async function refreshRoomList() {
  const res = await net.listPublicRooms();
  return res.rooms || [];
}

// Host deals the initial state (seated in seat order) and broadcasts it.
export async function startGame() {
  if (!session || !session.isHost) return;
  const ordered = [...session.players].sort((a, b) => a.seat - b.seat);
  if (ordered.length < 2) { cb.toast("Need at least 2 players."); return; }
  const names = ordered.map(p => p.name);
  const dealerIndex = randomInt(names.length);
  const s = createMatch(names, dealerIndex, { mode: "multiplayer" });
  startNextRound(s);
  try {
    const res = await net.startGame(session.roomId, serialize(s));
    session.started = true;
    session.status = "playing";
    session.lastSeq = res.seq;
    cb.setState(s);
    route();
    ensurePoll();
  } catch (e) {
    cb.toast(e.message || "Couldn't start the game.");
  }
}

export async function leave() {
  const id = session && session.roomId;
  net.stopPolling();
  session = null;
  replaying = false;
  if (id) { try { await net.leaveRoom(id); } catch (_) {} }
}

// ---- Turn commit ----
export async function commitTurn() {
  if (!session) return;
  const st = cb.getState();
  const lastTurn = { seat: session.mySeat, actions: session.recording || [] };
  try {
    const res = await net.submitTurn(session.roomId, {
      expectedSeq: session.lastSeq, state: serialize(st), lastTurn, finished: false,
    });
    session.lastSeq = res.seq;
    session.recording = null;
    route();
    ensurePoll();
  } catch (e) {
    if (e.status === 409 && e.data && e.data.state) {
      adopt(e.data.state, e.data.seq);
      cb.toast("Out of sync — board refreshed.");
      route();
    } else {
      cb.toast(e.message || "Couldn't submit your turn.");
    }
  }
}

// Host-only: advance to the next round, or finish the match.
export async function advance() {
  if (!session) return;
  const st = cb.getState();
  if (!session.isHost) { cb.toast("Waiting for the host to continue…"); return; }
  if (isMatchOver(st)) {
    await commitControl(true);
    cb.goMatchEnd();
    return;
  }
  advanceToNextRound(st);
  await commitControl(false);
  route();
}

async function commitControl(finished) {
  const st = cb.getState();
  try {
    const res = await net.submitTurn(session.roomId, {
      expectedSeq: session.lastSeq, state: serialize(st), lastTurn: null, finished: !!finished,
    });
    session.lastSeq = res.seq;
    if (finished) { session.status = "finished"; net.stopPolling(); }
    else ensurePoll();
  } catch (e) {
    if (e.status === 409 && e.data && e.data.state) { adopt(e.data.state, e.data.seq); route(); }
    else cb.toast(e.message || "Couldn't continue.");
  }
}

// ---- Routing ----
export function route() {
  const st = cb.getState();
  if (!st || !session) return;
  cb.clearSelection();
  if (st.phase === "roundOver") {
    cb.endSpectatorLock();
    cb.goRoundEnd();
    ensurePoll();
    return;
  }
  const mine = st.currentPlayerIndex === session.mySeat;
  if (mine) {
    net.stopPolling();            // I hold the turn — no other writer can land
    session.recording = [];
    beginTurn(st);
    cb.endSpectatorLock();
    cb.showScreen("screen-play");
    cb.renderAll();
  } else {
    session.recording = null;
    cb.showScreen("screen-play");
    cb.beginSpectatorLock();
    cb.renderAll();
    ensurePoll();
  }
}

function adopt(serializedState, seq) {
  cb.setState(hydrate(serializedState));
  session.lastSeq = seq;
}

// ---- Polling ----
function ensurePoll() {
  if (!session || net.isPolling()) return;
  net.startPolling(session.roomId, () => session.lastSeq, onPollUpdate, { intervalMs: 1500 });
}

async function onPollUpdate(server) {
  if (!session || !server) return;
  if (server.players) {
    session.players = server.players;
    cb.onRoster && cb.onRoster(server.players, server);
  }

  if (server.status === "finished") {
    if (server.state && server.seq > session.lastSeq) adopt(server.state, server.seq);
    session.status = "finished";
    net.stopPolling();
    cb.goMatchEnd();
    return;
  }

  if (server.status === "lobby") { session.status = "lobby"; return; }

  // status === "playing"
  if (!session.started) {
    if (!server.state) return;     // dealt state not visible yet
    session.started = true;
    session.status = "playing";
    adopt(server.state, server.seq);
    route();
    return;
  }

  if (server.seq > session.lastSeq && server.state) {
    if (replaying) return;
    replaying = true;
    try {
      const lt = server.lastTurn;
      if (lt && Array.isArray(lt.actions) && lt.seat !== session.mySeat) {
        await replayRemote(lt);
      }
      adopt(server.state, server.seq);
      route();
    } finally {
      replaying = false;
    }
  }
}

// Visualise a remote player's committed turn by replaying their action list
// through the same animated engine the CPU uses. Runs on our current pre-turn
// state (identical across clients), then the caller adopts the authoritative
// post-turn state.
async function replayRemote(lt) {
  const st = cb.getState();
  if (!st) return;
  cb.showScreen("screen-play");
  cb.beginSpectatorLock();
  beginTurn(st);                  // mirror the actor starting their turn
  cb.renderAll();
  for (const action of lt.actions) {
    const r = await cb.stepRemoteAction(action);
    if (!r || !r.ok) break;
  }
}

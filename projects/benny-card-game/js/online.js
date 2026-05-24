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
export function maxPlayers() { return session ? (session.maxPlayers || 0) : 0; }
export function isMyTurn() {
  const st = cb && cb.getState();
  return isActive() && st && st.currentPlayerIndex === session.mySeat;
}

// Append an action to the in-progress local turn (no-op unless it's my turn).
// Also stamps it with a wall-clock timestamp so spectators can pace replays.
// Intermediates carry the unsent slice (see flushIntermediate below).
export function record(action) {
  if (!session || !Array.isArray(session.recording)) return;
  session.recording.push({ ...action, at: Date.now() });
  // The discard action is the turn terminator — commitTurn handles it as the
  // final commit, no need for an intermediate push first.
  if (action && action.type !== "discard") scheduleIntermediate();
}

// ---- Mid-turn streaming (actor side) ----
// We debounce intermediate pushes so a rapid sequence of actions (e.g.,
// dragging several cards into one set) becomes one network write instead of
// many. The server accumulates the delta into last_turn.actions across calls.
let intermediateTimer = null;
let intermediateInFlight = false;
const INTERMEDIATE_DEBOUNCE_MS = 250;
function scheduleIntermediate() {
  if (intermediateTimer) clearTimeout(intermediateTimer);
  intermediateTimer = setTimeout(flushIntermediate, INTERMEDIATE_DEBOUNCE_MS);
}
async function flushIntermediate() {
  intermediateTimer = null;
  if (!session || intermediateInFlight) return;
  if (!Array.isArray(session.recording) || session.recording.length === 0) return;
  const st = cb && cb.getState();
  if (!st) return;
  // Only the actor pushes intermediates. If somehow the turn has moved on, bail.
  if (st.currentPlayerIndex !== session.mySeat) return;
  const delta = session.recording.slice(session.sentActionCount || 0);
  if (delta.length === 0) return;
  intermediateInFlight = true;
  const sendCount = session.recording.length;
  try {
    const res = await net.submitIntermediate(session.roomId, {
      expectedSeq: session.lastSeq, state: serialize(st), actionsDelta: delta,
    });
    session.lastSeq = res.seq;
    session.sentActionCount = sendCount;
  } catch (e) {
    // Stale seq or transient failure — the next intermediate (or the final
    // commit) will retry with the still-pending delta. Swallow silently so
    // the actor's UX isn't interrupted.
    if (e && e.status === 409 && e.data && e.data.seq) {
      // We're behind — bump local seq so future commits don't loop on 409.
      session.lastSeq = e.data.seq;
    }
  } finally {
    intermediateInFlight = false;
  }
}

// ---- Lobby ----
export async function createRoom(opts) {
  // Same safeguard as joinRoom — if a previous session left a poll loop alive
  // (e.g. user navigated back to the start screen without leaving the lobby),
  // its closure still points at the old roomId and would adopt that room's
  // state into this fresh session.
  net.stopPolling();
  const res = await net.createRoom(opts);
  enter(res, true);
  ensurePoll();
  return res;
}

export async function joinRoom(roomId, password, displayName) {
  // A stale poll from a previous session would otherwise keep running against
  // its old roomId and feed onPollUpdate the wrong game's state.
  net.stopPolling();
  const res = await net.joinRoom(roomId, password, displayName);
  enter(res, res.isHost);
  // Server hands back the live state on rejoin into an in-progress game so we
  // can adopt + route immediately. Without this the first poll would ask the
  // server for "anything newer than the current seq" and stall on a long-poll
  // until another player acted — i.e. multi-second "Joining game…" hang.
  if (res.state && res.status === "playing") {
    session.started = true;
    session.status = "playing";
    adopt(res.state, res.seq || 0);
    route();
  }
  ensurePoll();
  return res;
}

function enter(res, isHost) {
  session = {
    roomId: res.roomId, name: res.name, mySeat: res.seat, isHost,
    players: res.players || [], lastSeq: res.seq || 0,
    status: res.status || "lobby", started: false, recording: null,
    maxPlayers: Number(res.maxPlayers) || 0,
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
  // Tag the match as "online" so the profile screen + achievement evaluator
  // bucket the result into its own per-player stats slice instead of folding
  // it into the local multiplayer history.
  const s = createMatch(names, dealerIndex, { mode: "online" });
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
  tearDownSession();
  if (id) { try { await net.leaveRoom(id); } catch (_) {} }
}

// Archive: the user is permanently dropping this table. Server removes their
// seat, decrements max_players, and auto-deletes the room if it falls below
// the minimum viable size. Returns the server response so callers can refresh
// the "Your tables" list with the new state.
export async function archive(targetRoomId) {
  const id = targetRoomId || (session && session.roomId);
  if (!id) return { ok: true };
  if (session && session.roomId === id) tearDownSession();
  return net.archiveRoom(id);
}

// Host-only: end the game for everyone. Server hard-deletes the room.
export async function endGame(targetRoomId) {
  const id = targetRoomId || (session && session.roomId);
  if (!id) return { ok: true };
  if (session && session.roomId === id) tearDownSession();
  return net.endGame(id);
}

function tearDownSession() {
  net.stopPolling();
  if (intermediateTimer) { clearTimeout(intermediateTimer); intermediateTimer = null; }
  intermediateInFlight = false;
  session = null;
  replaying = false;
}

// ---- Turn commit ----
export async function commitTurn() {
  if (!session) return;
  // Cancel any pending debounced intermediate — we're about to send the final
  // commit including any unsent actions.
  if (intermediateTimer) { clearTimeout(intermediateTimer); intermediateTimer = null; }
  const st = cb.getState();
  // Send only the unsent slice; the server appends it to whatever
  // intermediates already accumulated, producing the full action list for
  // spectators (and a refreshed actor) to replay.
  const recording = session.recording || [];
  const delta = recording.slice(session.sentActionCount || 0);
  try {
    const res = await net.submitTurn(session.roomId, {
      expectedSeq: session.lastSeq, state: serialize(st), actionsDelta: delta, finished: false,
    });
    session.lastSeq = res.seq;
    session.recording = null;
    session.sentActionCount = 0;
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
    session.sentActionCount = 0;
    // Mid-turn resume guard: only start a fresh turn if the engine is at the
    // turn-start phase. If the actor refreshed mid-turn, server-stored state
    // will already be in canAct/mustDiscard — calling beginTurn would erase
    // their progress (reset hand draw, drop in-flight plays).
    if (st.phase === "mustDraw" || st.phase === "passing") beginTurn(st);
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
  if (!session) return;
  // If a poll loop is already running, it might be for a *previous* roomId
  // (captured in startPolling's closure). Keep it only if it matches the
  // current session — otherwise tear it down so the new room takes over.
  if (net.isPolling()) {
    if (net.pollingFor() === session.roomId) return;
    net.stopPolling();
  }
  // Long-poll only once the match is actually in progress. In the lobby the
  // games.seq doesn't bump when players join/leave seats, so we need to keep
  // short-polling to pick up roster changes. As soon as status flips to
  // "playing", subsequent ticks request `wait=1` and the server holds the
  // connection until a new seq lands (or ~9s elapses).
  const waitFn = () => session && session.status === "playing";
  net.startPolling(session.roomId, () => session.lastSeq, onPollUpdate, { intervalMs: 1500, waitFn, onError: onPollError });
}

// Called when a poll request rejects. A 404 means the room was deleted while
// we were in it (host ended the game, room was auto-pruned). Tell the host
// callback so the UI can bail out to the start screen.
function onPollError(err) {
  if (!session) return;
  if (err && err.status === 404) {
    tearDownSession();
    cb && cb.onRoomGone && cb.onRoomGone();
  }
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
        const result = await replayRemote(lt, session.spectating);
        if (result && result.isDone) {
          // Turn complete: actor discarded. Adopt the authoritative post-turn
          // state and route as normal (which will end the spectator lock and
          // possibly hand the next turn to us).
          session.spectating = null;
          adopt(server.state, server.seq);
          route();
        } else if (result) {
          // Intermediate: animations have already driven our local state to
          // match the server's mid-turn state. Bump seq so the next long-poll
          // request waits for the next intermediate; keep the spectator lock
          // on so the actor's screen is the only interactive one.
          session.spectating = result;
          session.lastSeq = server.seq;
        }
      } else {
        // Host control write or own-turn echo — just adopt the new state.
        adopt(server.state, server.seq);
        route();
      }
    } finally {
      replaying = false;
    }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Cap inter-action delays so an AFK actor doesn't freeze the spectator's UI.
const SPECTATOR_MAX_GAP_MS = 1500;
const SPECTATOR_MIN_GAP_MS = 80;   // small floor to keep animations legible

// Visualise a remote player's turn by replaying their action list through the
// same animated engine the CPU uses. Handles both one-shot replay (legacy full
// turn) and incremental replay (mid-turn streaming): the `prev` argument
// carries the actor seat + how many actions we've already played, so each
// intermediate only animates the new tail.
//
// Inter-action delays are paced from the actor's `at` timestamps to roughly
// match the rhythm of their real-time play (capped at SPECTATOR_MAX_GAP_MS).
async function replayRemote(lt, prev) {
  const st = cb.getState();
  if (!st) return null;
  cb.showScreen("screen-play");
  cb.beginSpectatorLock();

  const isNewTurn = !prev || prev.actorSeat !== lt.seat;
  let replayedCount = isNewTurn ? 0 : (prev.replayedCount || 0);

  if (isNewTurn) {
    beginTurn(st);                // mirror the actor starting their turn
    cb.renderAll();
  }

  const actions = Array.isArray(lt.actions) ? lt.actions : [];
  const newActions = actions.slice(replayedCount);
  let prevAt = prev && prev.lastActionAt ? prev.lastActionAt
             : (newActions[0] && newActions[0].at) || null;

  for (const action of newActions) {
    if (prevAt && action.at) {
      const raw = action.at - prevAt;
      const gap = Math.min(SPECTATOR_MAX_GAP_MS, Math.max(0, raw));
      if (gap > SPECTATOR_MIN_GAP_MS) await sleep(gap);
    }
    const r = await cb.stepRemoteAction(action);
    if (!r || !r.ok) break;
    if (action.at) prevAt = action.at;
    replayedCount += 1;
  }

  const last = actions[actions.length - 1];
  const isDone = !!(last && last.type === "discard");
  return { actorSeat: lt.seat, replayedCount, lastActionAt: prevAt, isDone };
}

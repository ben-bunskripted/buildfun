// Benny online — session controller. Bridges net.js (transport) and main.js
// (state + renderers). main.js owns `state` and all DOM, so it hands us a
// small callback bundle; we own session orchestration, server round-trips,
// and spectator replay.
//
// Server-authoritative v2: every game action is committed by the server
// before the client animates. The actor calls applyActionRemote(action) and
// awaits the server's response, then adopts the new (redacted-for-them)
// state. Spectators replay the action stream from last_turn.actions but
// against a redacted local state — see main.js:stepCpuAnimated for how it
// patches hidden cards from the action payload.

import * as net from "./net.js";
import {
  hydrate, isMatchOver, beginTurn,
} from "./game.js";

let cb = null;
// session: { roomId, name, mySeat, isHost, players[], lastSeq, status, started }
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

// ---- Action commit (actor side) ----
//
// Send one action to the server, await its response, and adopt the resulting
// authoritative state. Returns { ok, drawnCard?, noWayOut? } so the caller
// (main.js action sites) can drive any local follow-up (animations, screen
// transitions, etc.).
//
// On stale-seq the server returns 409 with the current state attached — we
// adopt and surface ok:false so the caller bails to its normal "out of sync"
// path. On any other failure we surface ok:false with the reason.
export async function applyActionRemote(action) {
  if (!session) return { ok: false, reason: "not in a session" };
  if (!isActive()) return { ok: false, reason: "session not active" };
  try {
    const res = await net.applyAction(session.roomId, {
      expectedSeq: session.lastSeq,
      action,
    });
    session.lastSeq = res.seq;
    if (res.state) adopt(res.state, res.seq);
    // The action may have ended this player's turn (advance to next seat) or
    // ended the round (phase=roundOver). Route handles either transition; if
    // the player is still mid-turn it's an idempotent re-render.
    route();
    return {
      ok: true,
      drawnCard: res.drawnCard || null,
      noWayOut: !!res.noWayOut,
      currentSeat: res.currentSeat,
      status: res.status,
    };
  } catch (e) {
    if (e && e.status === 409 && e.data && e.data.state) {
      // Stale — adopt server truth and let the caller decide what to do.
      adopt(e.data.state, e.data.seq);
      cb.toast("Out of sync — board refreshed.");
      route();
      return { ok: false, reason: "stale" };
    }
    cb.toast((e && e.message) || "Couldn't submit action.");
    return { ok: false, reason: (e && e.message) || "network" };
  }
}

// Convenience wrapper for action sites in main.js: if we're in an active
// online session, route through the server; otherwise run the local engine
// callback. Returns a uniform `{ok, reason?, drawnCard?, noWayOut?}` shape so
// the caller doesn't need to branch on online vs. local for the result.
export async function applyOnlineOrLocal({ action, localApply }) {
  if (isActive()) {
    const res = await applyActionRemote(action);
    return {
      ok: res.ok,
      reason: res.reason,
      drawnCard: res.drawnCard || null,
      noWayOut: !!res.noWayOut,
    };
  }
  const r = localApply();
  const ok = !!(r && r.ok);
  // Durability: persist synchronously, in the same frame the engine applied the
  // move, before this async function resolves. The caller awaits us and only
  // persists afterwards (a microtask later); a mobile PWA can be frozen or
  // killed at that await boundary. Without this, a move applied in memory — e.g.
  // a discard that ends the turn — would never reach localStorage, so on reopen
  // the player resumes pre-move and can repeat it (discard the same card twice).
  if (ok && cb && cb.persist) cb.persist();
  return { ok, reason: r && r.reason, drawnCard: null, noWayOut: false, ...((r && typeof r === "object") ? r : {}) };
}

// ---- Host control writes (round advance / match finish) ----
export async function advance() {
  if (!session || !session.isHost) { cb.toast("Waiting for the host to continue…"); return; }
  const st = cb && cb.getState();
  if (!st) return;
  const action = isMatchOver(st) ? "finishMatch" : "advanceRound";
  try {
    const res = await net.hostControl(session.roomId, { expectedSeq: session.lastSeq, action });
    session.lastSeq = res.seq;
    if (action === "finishMatch") {
      session.status = "finished";
      net.stopPolling();
      cb.goMatchEnd();
      return;
    }
    // advanceRound: the next poll (or our own immediate refresh) will land the
    // freshly-dealt state. Force a quick refresh so the user doesn't see a stale
    // round-end screen during the poll window. `useEtag: false` bypasses the
    // per-room ETag cache so we always get a body even if the server's seq
    // happens to match what we last saw.
    const data = await net.getRoom(session.roomId, 0, { useEtag: false });
    if (data && data.state) {
      adopt(data.state, data.seq);
      session.status = data.status || "playing";
      route();
      ensurePoll();
    }
  } catch (e) {
    if (e && e.status === 409 && e.data && e.data.state) {
      adopt(e.data.state, e.data.seq);
      route();
    } else {
      cb.toast((e && e.message) || "Couldn't continue.");
    }
  }
}

// ---- Lobby / session lifecycle ----
export async function createRoom(opts) {
  net.stopPolling();
  const res = await net.createRoom(opts);
  enter(res, true);
  ensurePoll();
  return res;
}

export async function joinRoom(roomId, password, displayName) {
  net.stopPolling();
  const res = await net.joinRoom(roomId, password, displayName);
  enter(res, res.isHost);
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
    status: res.status || "lobby", started: false,
    maxPlayers: Number(res.maxPlayers) || 0,
  };
}

export async function refreshRoomList() {
  const res = await net.listPublicRooms();
  return res.rooms || [];
}

// Server-authoritative deal: client just signals "go".
export async function startGame() {
  if (!session || !session.isHost) return;
  if ((session.players || []).length < 2) { cb.toast("Need at least 2 players."); return; }
  try {
    await net.startGame(session.roomId);
    session.status = "playing";
    // Don't bump session.lastSeq here. The poll loop will request `since` at
    // the current value (typically 0 for the host) and the server will return
    // the freshly-dealt state at seq=1. Once that lands, onPollUpdate adopts
    // it and flips `session.started`. If we bumped lastSeq to 1 here, the
    // next poll would ask for seq>1 and the host would never see the deal.
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

export async function archive(targetRoomId) {
  const id = targetRoomId || (session && session.roomId);
  if (!id) return { ok: true };
  if (session && session.roomId === id) tearDownSession();
  return net.archiveRoom(id);
}

export async function endGame(targetRoomId) {
  const id = targetRoomId || (session && session.roomId);
  if (!id) return { ok: true };
  if (session && session.roomId === id) tearDownSession();
  return net.endGame(id);
}

function tearDownSession() {
  net.stopPolling();
  session = null;
  replaying = false;
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
    // No need to stop polling — without intermediate writes the actor and
    // poll loop can coexist safely; the poll just echoes what the actor's
    // applyActionRemote already adopted.
    //
    // The server stores `phase: "passing"` between turns (engine idle state),
    // so when we first pick up our own turn from a poll the action handlers
    // would all gate out (`phase !== "mustDraw"`). beginTurn() flips passing
    // → mustDraw (or canAct for the dealer's opener). We guard on the entry
    // phase so mid-turn refreshes don't clobber a canAct/mustDiscard state.
    if (st.phase === "passing") beginTurn(st);
    cb.endSpectatorLock();
    cb.showScreen("screen-play");
    cb.renderAll();
  } else {
    cb.showScreen("screen-play");
    cb.beginSpectatorLock();
    cb.renderAll();
  }
  ensurePoll();
}

function adopt(serializedState, seq) {
  cb.setState(hydrate(serializedState));
  session.lastSeq = seq;
}

// ---- Polling ----
function ensurePoll() {
  if (!session) return;
  if (net.isPolling()) {
    if (net.pollingFor() === session.roomId) return;
    net.stopPolling();
  }
  // Lobby rosters change slowly — poll every 5s. Once status flips to
  // "playing" we tighten to 1.5s so spectators see opponent actions promptly.
  // The interval function is consulted per-tick so the loop adapts as
  // session.status moves lobby → playing → lobby (rematch) without restart.
  const intervalMs = () => (session && session.status === "playing" ? 1500 : 5000);
  net.startPolling(session.roomId, () => session.lastSeq, onPollUpdate, { intervalMs, onError: onPollError });
}

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
          session.spectating = null;
          adopt(server.state, server.seq);
          route();
        } else if (result) {
          session.spectating = result;
          session.lastSeq = server.seq;
        }
      } else {
        // Host control write or own-turn echo — adopt and reroute.
        adopt(server.state, server.seq);
        route();
      }
    } finally {
      replaying = false;
    }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SPECTATOR_MAX_GAP_MS = 1500;
const SPECTATOR_MIN_GAP_MS = 80;

// Replay a remote player's actions through the same animated engine the CPU
// uses. The local state for spectators has the actor's hand redacted (opaque
// placeholders), so before each engine apply we ensure the action's referenced
// cards exist in the actor's hand — patching in real cards that the action
// payload carries (discard.card, swap.natural, play/add arrangement cards).
// That's enough for the engine to find by id and animate normally.
async function replayRemote(lt, prev) {
  const st = cb.getState();
  if (!st) return null;
  cb.showScreen("screen-play");
  cb.beginSpectatorLock();

  const isNewTurn = !prev || prev.actorSeat !== lt.seat;
  let replayedCount = isNewTurn ? 0 : (prev.replayedCount || 0);

  if (isNewTurn) {
    // The engine's beginTurn() flips phase passing→mustDraw and clears
    // lastDrawnCardId. Safe to call locally — no hidden info needed.
    beginTurn(st);
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

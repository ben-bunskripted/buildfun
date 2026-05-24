// Benny online — transport + Netlify Identity. No DOM, no game logic.
// Everything here is data in / data out so the rest of the app stays testable.

const API = "/.netlify/functions";

let identity = null;
const authListeners = new Set();

function mapUser(u) {
  if (!u) return null;
  const meta = u.user_metadata || {};
  return { uid: u.id || u.sub, email: u.email || "", name: (meta.full_name || meta.name || u.email || "Player").slice(0, 40) };
}

function notifyAuth(u) {
  const mapped = mapUser(u);
  for (const fn of authListeners) { try { fn(mapped); } catch (_) {} }
}

// Wire up the Netlify Identity widget (loaded from CDN in index.html). Resolves
// with the current user (or null) once the widget reports ready.
export function initIdentity() {
  identity = window.netlifyIdentity || null;
  if (!identity) return Promise.resolve(null);
  return new Promise((resolve) => {
    let resolved = false;
    identity.on("init", (user) => { if (!resolved) { resolved = true; resolve(mapUser(user)); } notifyAuth(user); });
    identity.on("login", (user) => { identity.close(); notifyAuth(user); });
    identity.on("logout", () => notifyAuth(null));
    identity.init();
    // Safety net if the widget never fires "init" (e.g. blocked offline).
    setTimeout(() => { if (!resolved) { resolved = true; resolve(currentUser()); } }, 4000);
  });
}

export function onAuth(fn) { authListeners.add(fn); return () => authListeners.delete(fn); }
export function isIdentityAvailable() { return !!identity; }
export function currentUser() { return identity ? mapUser(identity.currentUser()) : null; }
export function signIn() { if (identity) identity.open("login"); }
export function signOut() { if (identity) identity.logout(); }

async function authToken() {
  if (!identity) return null;
  const u = identity.currentUser();
  if (!u) return null;
  try { return await u.jwt(); } catch (_) { return null; }
}

// Per-(etagKey) cache of the last ETag the server returned. When the caller
// passes `etagKey`, the next request sends `If-None-Match: <cached etag>` and
// a 304 response short-circuits to `{ unchanged: true }` — no JSON parse, no
// body read. Used by getRoom() so most polls hit a 304 fast path on the
// server (no state read, no roster read, no presence write).
const etags = new Map();
export function clearEtag(key) { etags.delete(key); }

async function api(name, { method = "GET", body, query, etagKey = null, signal = null } = {}) {
  let url = `${API}/${name}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  const headers = {};
  const token = await authToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (etagKey) {
    const prev = etags.get(etagKey);
    if (prev) headers["If-None-Match"] = prev;
  }
  const opts = { method, headers };
  if (signal) opts.signal = signal;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (etagKey && res.status === 304) return { unchanged: true };
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  if (etagKey) {
    const et = res.headers.get("ETag");
    if (et) etags.set(etagKey, et);
  }
  return data;
}

// ---- API surface ----
export function syncAuth(displayName) { return api("auth-sync", { method: "POST", body: { displayName } }); }
export function createRoom(opts) { return api("create-room", { method: "POST", body: opts }); }
export function listPublicRooms() { return api("list-rooms"); }
export function listMyRooms() { return api("my-rooms"); }
export function joinRoom(roomId, password, displayName) {
  return api("join-room", { method: "POST", body: { roomId, password, displayName } });
}
// Server-authoritative: host sends only the room id; the server deals from
// the current room_seats and writes the canonical state.
export function startGame(roomId) { return api("start-game", { method: "POST", body: { roomId } }); }
// Apply a single action server-side. `payload` is { expectedSeq, action }.
// Response includes the post-state redacted for the caller's seat, plus
// `drawnCard` on drawDeck (actor only).
export function applyAction(roomId, payload) { return api("apply-action", { method: "POST", body: { roomId, ...payload } }); }
// Host control writes. `action` is "advanceRound" | "finishMatch".
export function hostControl(roomId, payload) { return api("submit-turn", { method: "POST", body: { roomId, ...payload } }); }
// `opts.useEtag = false` bypasses the per-room ETag cache — used by callers
// that need the full state on the next response regardless of seq (e.g. the
// immediate refresh after a host advanceRound).
export function getRoom(roomId, since, opts) {
  const query = { roomId, since: since || 0 };
  const useEtag = !(opts && opts.useEtag === false);
  const signal = opts && opts.signal ? opts.signal : null;
  return api("get-room", { query, etagKey: useEtag ? `get-room:${roomId}` : null, signal });
}
export function leaveRoom(roomId) { return api("leave-room", { method: "POST", body: { roomId } }); }
export function archiveRoom(roomId) { return api("leave-room", { method: "POST", body: { roomId, archive: true } }); }
export function endGame(roomId) { return api("end-game", { method: "POST", body: { roomId } }); }

// ---- Polling (single in-flight, self-rescheduling) ----
let pollTimer = null;
let polling = false;
let inFlight = false;
let inFlightAbort = null;
let pollingRoomId = null;
let visibilityHandler = null;
// Bumped on every (re)start so a previous loop's in-flight response can't
// fire onUpdate after we've swapped to a new session/room.
let pollGen = 0;

// Exponential backoff cap. Quiet polls (304 responses) double the next
// interval up to this ceiling; any 200 (state changed) resets to the base.
const BACKOFF_MAX_INTERVAL_MS = 5 * 60 * 1000;

// `intervalMs` may be a number or a `() => number` so the caller can adapt
// the cadence to session state (e.g. 5s in lobby, 1.5s while playing) without
// restarting the loop. Polling pauses while `document.hidden` and resumes
// with an immediate tick on `visibilitychange` so a backgrounded tab stops
// hitting the server but catches up fast on return.
//
// Exponential backoff: each 304 (server says "nothing changed") doubles the
// next interval, capped at BACKOFF_MAX_INTERVAL_MS. Any 200 resets to the
// base. So a quiet lobby decays from 5s → 10s → 20s → … → 5min over a few
// minutes; one player joining drops everyone back to 5s on the next tick.
// The backoff also resets when the base interval changes (e.g. lobby→
// playing), so a starting game immediately polls at 1.5s rather than
// inheriting the lobby's stale backoff.
export function startPolling(roomId, sinceFn, onUpdate, opts = {}) {
  stopPolling();
  // Fresh session — any cached ETag from a previous poll loop is stale.
  etags.delete(`get-room:${roomId}`);
  polling = true;
  pollingRoomId = roomId;
  const gen = ++pollGen;
  const alive = () => polling && gen === pollGen;
  const intervalOpt = opts.intervalMs != null ? opts.intervalMs : 1500;
  const onError = opts.onError || null;
  const baseInterval = () => (typeof intervalOpt === "function" ? intervalOpt() : intervalOpt);
  let backoffStep = 0;
  let lastBase = null;
  const nextInterval = () => {
    const base = baseInterval();
    // Base changed (lobby → playing or vice versa): drop the accumulated
    // backoff so the new cadence kicks in immediately.
    if (lastBase !== null && lastBase !== base) backoffStep = 0;
    lastBase = base;
    const backed = base * Math.pow(2, backoffStep);
    return Math.min(backed, BACKOFF_MAX_INTERVAL_MS);
  };
  const docHidden = () => (typeof document !== "undefined" && document.hidden);
  const schedule = () => {
    if (!alive()) return;
    clearTimeout(pollTimer);
    pollTimer = null;
    // Backgrounded → don't schedule; the visibilitychange handler will tick
    // immediately when the tab comes back.
    if (docHidden()) return;
    pollTimer = setTimeout(tick, nextInterval());
  };
  const tick = async () => {
    if (!alive()) return;
    if (docHidden()) return;
    if (inFlight) { schedule(); return; }
    inFlight = true;
    // Per-tick AbortController so stopPolling / visibility-hidden can cancel
    // the long-poll instead of leaving a function invocation alive for ~9 s.
    const ac = (typeof AbortController !== "undefined") ? new AbortController() : null;
    inFlightAbort = ac;
    try {
      const data = await getRoom(roomId, sinceFn(), { signal: ac ? ac.signal : null });
      if (data && data.unchanged) {
        // 304 — server said nothing changed. Back off; next interval doubles.
        backoffStep += 1;
      } else if (data) {
        // 200 — fresh state. Snap back to base cadence and notify the caller.
        backoffStep = 0;
        if (alive() && onUpdate) await onUpdate(data);
      }
      // Errors leave backoffStep alone (handled in catch).
    } catch (e) {
      if (e && (e.name === "AbortError" || e.code === 20)) {
        // Cancelled by stopPolling or visibility change — not a real error.
      } else if (alive() && onError) {
        // Transient errors are swallowed and retried on the next tick. A 404
        // means the room was deleted (host ended it, archived to oblivion);
        // let the caller decide whether to keep polling.
        try { await onError(e); } catch (_) {}
      }
    } finally {
      inFlight = false;
      if (inFlightAbort === ac) inFlightAbort = null;
      schedule();
    }
  };
  if (typeof document !== "undefined") {
    visibilityHandler = () => {
      if (!alive()) return;
      if (document.hidden) {
        clearTimeout(pollTimer);
        pollTimer = null;
        // Cancel any in-flight long-poll: iOS may suspend the request anyway,
        // and we don't want a phantom response landing when the tab returns.
        if (inFlightAbort) { try { inFlightAbort.abort(); } catch (_) {} }
      } else {
        // Catch up immediately, then resume normal cadence.
        clearTimeout(pollTimer);
        pollTimer = null;
        tick();
      }
    };
    document.addEventListener("visibilitychange", visibilityHandler);
  }
  tick();
}

export function isPolling() { return polling; }
export function pollingFor() { return polling ? pollingRoomId : null; }
export function stopPolling() {
  polling = false;
  pollingRoomId = null;
  clearTimeout(pollTimer);
  pollTimer = null;
  if (inFlightAbort) { try { inFlightAbort.abort(); } catch (_) {} inFlightAbort = null; }
  if (visibilityHandler && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
}

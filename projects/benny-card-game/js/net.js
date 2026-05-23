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

async function api(name, { method = "GET", body, query } = {}) {
  let url = `${API}/${name}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  const headers = {};
  const token = await authToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---- API surface ----
export function syncAuth(displayName) { return api("auth-sync", { method: "POST", body: { displayName } }); }
export function createRoom(opts) { return api("create-room", { method: "POST", body: opts }); }
export function listPublicRooms() { return api("list-rooms"); }
export function joinRoom(roomId, password, displayName) {
  return api("join-room", { method: "POST", body: { roomId, password, displayName } });
}
export function startGame(roomId, state) { return api("start-game", { method: "POST", body: { roomId, state } }); }
export function getRoom(roomId, since, wait) {
  const query = { roomId, since: since || 0 };
  if (wait) query.wait = "1";
  return api("get-room", { query });
}
export function submitTurn(roomId, payload) { return api("submit-turn", { method: "POST", body: { roomId, ...payload } }); }
export function leaveRoom(roomId) { return api("leave-room", { method: "POST", body: { roomId } }); }

// ---- Polling (single in-flight, self-rescheduling) ----
let pollTimer = null;
let polling = false;
let inFlight = false;

// `waitFn()` is consulted per-tick. When it returns true the request asks the
// server to long-poll (hold the connection until a new seq lands or ~9s
// elapses). In long-poll mode the inter-tick interval drops to 200ms — the
// server-side wait is what paces requests, not a client-side timer.
export function startPolling(roomId, sinceFn, onUpdate, { intervalMs = 1500, waitFn = null } = {}) {
  stopPolling();
  polling = true;
  const schedule = () => {
    if (!polling) return;
    const useWait = !!(waitFn && waitFn());
    pollTimer = setTimeout(tick, useWait ? 200 : intervalMs);
  };
  const tick = async () => {
    if (!polling || inFlight) { schedule(); return; }
    inFlight = true;
    try {
      const useWait = !!(waitFn && waitFn());
      const data = await getRoom(roomId, sinceFn(), useWait);
      if (polling && onUpdate) await onUpdate(data);
    } catch (_e) {
      // Keep polling through transient errors; the next tick may recover.
    } finally {
      inFlight = false;
      schedule();
    }
  };
  tick();
}

export function isPolling() { return polling; }
export function stopPolling() { polling = false; clearTimeout(pollTimer); pollTimer = null; }

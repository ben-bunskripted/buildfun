// Shared helpers for the Benny online-multiplayer functions.
//
// Files prefixed with "_" are treated as helper modules by Netlify, not
// deployed as their own endpoints.

import { neon } from "@netlify/neon";

let _sql = null;
// Lazily create the Neon client so importing this module never throws when the
// DB env var is missing. `@netlify/neon`'s neon() reads NETLIFY_DATABASE_URL
// automatically — and its presence in package.json is what tells Netlify to
// provision the database + inject that env var on deploy.
export function db() {
  if (_sql) return _sql;
  _sql = neon();
  return _sql;
}

// Netlify Identity populates context.clientContext.user from a valid
// `Authorization: Bearer <jwt>` header. Returns a normalized user or null.
export function getUser(context) {
  const u = context && context.clientContext && context.clientContext.user;
  if (!u || !u.sub) return null;
  const meta = u.user_metadata || {};
  return {
    uid: u.sub,
    email: u.email || "",
    name: (meta.full_name || meta.name || u.email || "Player").toString().slice(0, 40),
  };
}

export function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

export function parseBody(event) {
  try { return JSON.parse(event.body || "{}"); } catch (_) { return {}; }
}

// Return a 413 if the request body exceeds `maxBytes`. Use before `parseBody`
// so a malicious client can't push megabytes of garbage into a function.
export function checkBodySize(event, maxBytes) {
  const body = event && event.body;
  if (typeof body === "string" && body.length > maxBytes) {
    return json(413, { error: "request too large" });
  }
  return null;
}

// ---- Rate limiting (DB-backed sliding window) ----
//
// One row per request in `rate_limit_log` (uid, endpoint, ts). Before
// inserting we count recent rows in the window — if over budget, reject.
// Cheap (~2 round trips per request) and resilient across function cold
// starts since the state lives in the DB.
//
// Budgets are intentionally generous for a friends-only game; the goal is to
// stop brute-force / scripted abuse, not throttle real play.
const RATE_WINDOW_SECONDS = 60;
const RATE_BUDGETS = {
  // Auth + lobby ops: low-volume, low-cost. Stricter to slow password attacks.
  "auth-sync":   { max: 30,  window: 60 },
  "create-room": { max: 10,  window: 60 },
  "join-room":   { max: 20,  window: 60 },
  "leave-room":  { max: 30,  window: 60 },
  "end-game":    { max: 10,  window: 60 },
  "start-game":  { max: 10,  window: 60 },
  "list-rooms":  { max: 60,  window: 60 },
  "my-rooms":    { max: 60,  window: 60 },
  // Gameplay: many actions per turn, long polls per round. Loose budgets.
  "apply-action":{ max: 240, window: 60 },
  "submit-turn": { max: 60,  window: 60 },
  "get-room":    { max: 600, window: 60 },
  default:       { max: 120, window: 60 },
};

// Returns null if within budget, otherwise a 429 response ready to return.
// `endpoint` is the function name (without `.mjs`). Best-effort: any DB error
// fails open so a transient outage doesn't take down the game.
export async function rateLimit(sql, user, endpoint) {
  if (!user || !user.uid) return null; // unauthenticated requests get caught elsewhere
  const cfg = RATE_BUDGETS[endpoint] || RATE_BUDGETS.default;
  const windowSec = cfg.window || RATE_WINDOW_SECONDS;
  try {
    // Count requests in the rolling window, then insert this one. Race
    // tolerated: we don't need transactional accuracy, only an effective cap.
    const rows = await sql`
      SELECT count(*)::int AS n
      FROM rate_limit_log
      WHERE uid = ${user.uid} AND endpoint = ${endpoint}
        AND ts > now() - (${windowSec} || ' seconds')::interval`;
    const n = rows && rows[0] ? Number(rows[0].n) : 0;
    if (n >= cfg.max) {
      return json(429, {
        error: "Too many requests — slow down.",
        retryAfterSeconds: windowSec,
      });
    }
    await sql`INSERT INTO rate_limit_log (uid, endpoint, ts) VALUES (${user.uid}, ${endpoint}, now())`;
    // Opportunistic cleanup: ~1% of inserts also prune stale rows so the
    // table doesn't grow unbounded. Cheaper than running a cron.
    if (Math.random() < 0.01) {
      await sql`DELETE FROM rate_limit_log WHERE ts < now() - interval '1 hour'`;
    }
  } catch (_err) {
    // Fail open. A short DB blip shouldn't 429 paying users.
    return null;
  }
  return null;
}

// ---- Password hashing (PBKDF2 via Web Crypto; no native deps) ----
//
// Format: `pbkdf2$<iterations>$<saltHex>$<hashHex>`. The version prefix lets
// us migrate later (e.g., to Argon2 if we add a native dep) without breaking
// older stored hashes.
//
// Legacy v1 format `<saltHex>$<digestHex>` (single-round SHA-256) is still
// accepted by `verifyPassword` so any pre-cutover rows in the wild keep
// working until the next room creation rotates them. New writes always use
// PBKDF2.
const PBKDF2_ITERS = 210_000;
const PBKDF2_HASH = "SHA-256";
const PBKDF2_KEYLEN_BITS = 256;

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function pbkdf2(pw, salt, iters) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pw),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: iters, hash: PBKDF2_HASH },
    key,
    PBKDF2_KEYLEN_BITS,
  );
  return new Uint8Array(bits);
}

// Constant-time byte comparison. Always walks the full longer length so the
// timing doesn't leak the position of the first mismatch.
function timingSafeEqual(a, b) {
  const la = a.length, lb = b.length;
  let diff = la ^ lb;
  const max = Math.max(la, lb);
  for (let i = 0; i < max; i++) {
    diff |= (a[i] || 0) ^ (b[i] || 0);
  }
  return diff === 0;
}

export async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pw, salt, PBKDF2_ITERS);
  return `pbkdf2$${PBKDF2_ITERS}$${toHex(salt)}$${toHex(hash)}`;
}

// Fixed dummy salt used to burn PBKDF2 cycles on paths that wouldn't
// otherwise hit the KDF. Equalizes timing so an attacker can't tell the
// stored-hash format (or "no such room") from response latency.
const DUMMY_PBKDF2_SALT = new Uint8Array(16);

export async function verifyPassword(pw, stored) {
  // Always do one PBKDF2 derivation against `pw` regardless of which branch
  // we end up taking. Without this, the legacy and malformed-format paths
  // return in microseconds while the PBKDF2 path takes ~50ms — leaking the
  // stored format (or whether a room exists at all when the caller passes
  // a missing stored hash). The result is discarded.
  const burn = pbkdf2(pw || "", DUMMY_PBKDF2_SALT, PBKDF2_ITERS);

  if (!stored) { await burn; return false; }
  const s = String(stored);
  if (s.startsWith("pbkdf2$")) {
    const parts = s.split("$");
    if (parts.length !== 4) { await burn; return false; }
    const iters = Number(parts[1]);
    if (!Number.isInteger(iters) || iters < 1000) { await burn; return false; }
    const salt = fromHex(parts[2]);
    const expected = fromHex(parts[3]);
    const got = await pbkdf2(pw, salt, iters);
    await burn;
    return timingSafeEqual(got, expected);
  }
  // Legacy v1: salt$hash, single-round SHA-256(salt:pw).
  const parts = s.split("$");
  if (parts.length !== 2) { await burn; return false; }
  const [saltHex, expectedHex] = parts;
  if (!saltHex || !expectedHex) { await burn; return false; }
  const data = new TextEncoder().encode(`${saltHex}:${pw}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  await burn;
  return timingSafeEqual(digest, fromHex(expectedHex));
}

// ---- Room join codes ----
// Unambiguous alphabet (no 0/O/1/I).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function makeRoomCode(len = 5) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

// ---- Canonical display name ----
//
// The server is the source of truth for what name appears on a seat. Clients
// can pass a `displayName` to `auth-sync` to update their stored profile name,
// but `create-room` / `join-room` ignore any client-supplied `displayName`
// and look up `users.display_name` instead — so one user can't impersonate
// another by typing their name into the lobby.
//
// On first sign-in `users` may not have a row yet (auth-sync hasn't run), so
// fall back to the JWT-derived name, then a sanitized email prefix, then
// "Player". Always trimmed to 40 chars.
export async function canonicalDisplayName(sql, user) {
  const rows = await sql`SELECT display_name FROM users WHERE uid = ${user.uid}`;
  const fromDb = rows && rows[0] && rows[0].display_name;
  const fallback = (user && user.name) || (user && user.email && user.email.split("@")[0]) || "Player";
  const raw = (fromDb || fallback || "Player").toString();
  return raw.trim().slice(0, 40) || "Player";
}

// ---- Per-user active-table cap ----
// A user can hold at most this many seats across non-finished rooms at once.
// Hitting the cap forces them to archive an old table before joining/creating.
export const MAX_ACTIVE_ROOMS_PER_USER = 10;

export async function countActiveRoomsForUser(sql, uid) {
  const rows = await sql`
    SELECT COUNT(*)::int AS n
    FROM room_seats s
    JOIN rooms r ON r.id = s.room_id
    WHERE s.uid = ${uid} AND r.status != 'finished'`;
  return rows[0] ? Number(rows[0].n) : 0;
}

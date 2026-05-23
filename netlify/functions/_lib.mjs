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

// ---- Password hashing (Web Crypto; no native deps) ----
function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function hashPassword(pw, saltHex) {
  const salt = saltHex || toHex(crypto.getRandomValues(new Uint8Array(16)));
  const data = new TextEncoder().encode(`${salt}:${pw}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `${salt}$${toHex(digest)}`;
}
export async function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt] = String(stored).split("$");
  if (!salt) return false;
  const recomputed = await hashPassword(pw, salt);
  return recomputed === stored;
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

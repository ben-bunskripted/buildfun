// One-off (idempotent) schema creation. Hit this once after enabling Netlify DB:
//   GET /.netlify/functions/setup-db   (must be signed in)
// Safe to re-run — every statement is IF NOT EXISTS.

import { db, getUser, json } from "./_lib.mjs";

export const handler = async (event, context) => {
  if (!getUser(context)) return json(401, { error: "sign-in required" });
  const sql = db();
  try {
    await sql`CREATE TABLE IF NOT EXISTS users (
      uid TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT 'Player',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host_uid TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public',
      password_hash TEXT,
      status TEXT NOT NULL DEFAULT 'lobby',
      max_players INT NOT NULL DEFAULT 4,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS room_seats (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      seat_index INT NOT NULL,
      uid TEXT NOT NULL,
      display_name TEXT NOT NULL,
      connected BOOLEAN NOT NULL DEFAULT true,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (room_id, seat_index)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS games (
      room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
      seq BIGINT NOT NULL DEFAULT 0,
      current_seat INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'lobby',
      state JSONB,
      last_turn JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS rooms_public_lobby_idx ON rooms (visibility, status, updated_at DESC)`;
    return json(200, { ok: true });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

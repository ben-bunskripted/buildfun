-- Benny online — Neon Postgres schema.
--
-- Idempotent: every CREATE is IF NOT EXISTS, so safe to re-run on an existing
-- database. Run via psql against your Netlify-provisioned Neon DB:
--
--   psql "$NETLIFY_DATABASE_URL" -f netlify/schema.sql
--
-- (Grab the connection string from Netlify → Site configuration → Environment
-- variables → NETLIFY_DATABASE_URL.)

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'Player',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host_uid TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'lobby',
  max_players INT NOT NULL DEFAULT 4,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_seats (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seat_index INT NOT NULL,
  uid TEXT NOT NULL,
  display_name TEXT NOT NULL,
  connected BOOLEAN NOT NULL DEFAULT true,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, seat_index)
);

-- Backfill for existing deployments (no-op on fresh installs).
ALTER TABLE room_seats ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS games (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL DEFAULT 0,
  current_seat INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'lobby',
  state JSONB,
  last_turn JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backs the per-uid sliding-window rate limiter in `_lib.mjs:rateLimit`.
-- Rows are pruned opportunistically by INSERT (~1% chance); a nightly
-- `DELETE FROM rate_limit_log WHERE ts < now() - interval '1 hour'` is
-- optional if you want tidier table growth.
CREATE TABLE IF NOT EXISTS rate_limit_log (
  uid TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_limit_log_uid_endpoint_ts
  ON rate_limit_log (uid, endpoint, ts DESC);

CREATE INDEX IF NOT EXISTS rooms_public_lobby_idx
  ON rooms (visibility, status, updated_at DESC);

COMMIT;

-- ----------------------------------------------------------------------------
-- v1 → v2 cutover (server-authoritative trust model)
--
-- The v2 protocol redacts hands and changes how state is committed, so any
-- in-progress v1 game will throw on its next action. Run this DELETE once
-- after deploying the v2 functions to clear those rows. Safe to re-run; it
-- only affects non-finished rooms and cascades cleanly to room_seats + games.
-- Comment out if you don't want it.
-- ----------------------------------------------------------------------------
DELETE FROM rooms WHERE status IN ('lobby', 'playing');

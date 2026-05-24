# Benny Online Multiplayer — Netlify Setup

Benny's online mode runs entirely on Netlify: the static frontend (unchanged,
no build step) talks to a small **Netlify Functions** API, which reads/writes a
**Netlify DB** (Neon Postgres). Sign-in is **Netlify Identity** (Google + email).

Local play (Multiplayer / Solo / Scoring) needs none of this and keeps
working with zero configuration. The steps below only enable the **Online** tab.

---

## 1. Enable Netlify DB

The functions use the **`@netlify/neon`** driver (declared in the root
`package.json`). Netlify's Neon Database extension detects this package and
provisions a Neon Postgres instance, injecting a `NETLIFY_DATABASE_URL`
environment variable that the code reads automatically (see
`netlify/functions/_lib.mjs`). No connection string lives in the repo.

Two ways to provision:

- **Dashboard:** **Project configuration → Database → Enable Netlify DB**, then
  **redeploy** so the running functions pick up `NETLIFY_DATABASE_URL`.
- **CLI:** `netlify db init` (creates the database and sets the env var on the
  site), then deploy.

> Important: `@netlify/neon` must be present in `package.json` for the env var
> to be wired up, and the site must be **redeployed after** the DB is enabled —
> otherwise functions throw "connection string is not provided … `NETLIFY_DATABASE_URL`".
> If you deploy via the CLI, run `npm install` first.

## 2. Enable Netlify Identity

**Project configuration → Identity → Enable Identity.**

Then under Identity settings:

- **Registration:** choose Open (anyone can sign up) or Invite-only, as you prefer.
- **External providers → add Google.** (Email/password works out of the box;
  Google needs you to register an OAuth app and paste the client ID/secret, or
  use Netlify's shared credentials for testing.)

The frontend loads the Identity widget from
`https://identity.netlify.com/v1/netlify-identity-widget.js` (already wired into
`index.html`). The functions trust the Identity JWT automatically via
`context.clientContext.user` — there's no manual token verification to set up.

## 3. Create the database schema

Once the DB is enabled, run the following SQL in the **Neon SQL Editor**
(Project dashboard → Database → Open in Neon). Every statement is
`IF NOT EXISTS` so it's safe to re-run.

```sql
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

-- Existing deployments: add the presence column in-place.
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
-- One row per (uid, endpoint, minute-bucket) — a counter, not a log.
-- Each request UPSERTs and increments the current bucket; the limiter
-- SUMs counts across buckets in the window. Two orders of magnitude
-- fewer writes than a row-per-request log.
CREATE TABLE IF NOT EXISTS rate_limit_bucket (
  uid TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,
  count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, endpoint, bucket_start)
);
CREATE INDEX IF NOT EXISTS rate_limit_bucket_cleanup
  ON rate_limit_bucket (bucket_start);

-- Legacy v1 limiter table. The new code never reads or writes it; kept
-- here for one deploy cycle in case of rollback. Drop in a follow-up.
CREATE TABLE IF NOT EXISTS rate_limit_log (
  uid TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_limit_log_uid_endpoint_ts
  ON rate_limit_log (uid, endpoint, ts DESC);

CREATE INDEX IF NOT EXISTS rooms_public_lobby_idx
  ON rooms (visibility, status, updated_at DESC);
```

## 4. Play

Open Benny → **Online** tab → **Sign in** → **Create table** (or **Join by
code** / pick a public table). Share the 5-character code with friends. The host
presses **Start game** once at least two players have joined.

---

## Local development (optional)

To run the functions + DB locally you need the Netlify CLI:

```sh
npm install
netlify login
netlify link            # link this folder to your Netlify site
netlify dev             # serves the static site + functions at localhost:8888
```

`netlify dev` pulls the linked site's env vars (including
`NETLIFY_DATABASE_URL`) so the functions can reach the real Neon database.
Plain `python -m http.server` still serves the static game, but the Online tab
will report the API as unavailable (no functions backend).

---

## How it works (one paragraph)

A room row holds the serialized match `state` (JSONB), the finishing player's
`last_turn` (an action list), a monotonic `seq`, and the `current_seat`. Only
the player whose turn it is can write a turn (the host writes round
advancement). Everyone else **polls** `get-room?since=<seq>` about every 1.5s;
when a newer `seq` arrives they **replay** `last_turn` through the same animation
engine the CPU uses, then adopt the authoritative state. Turn-based play makes
the ~1.5s poll latency a non-issue, so there are no websockets to manage.

## Trust model (server-authoritative)

The server holds the canonical state and applies every move via the same
`game.js`/`rules.js` engine the client uses. Clients send typed actions
(`drawDeck`, `drawDiscard`, `play`, `add`, `swap`, `discard`) through
`/.netlify/functions/apply-action`; the server validates the actor's seat,
the engine validates legality, and only then is the row updated. Every
poll response redacts other players' hands and the deck to opaque
placeholders — no client ever sees hidden info. The `drawnCard` from a deck
draw is sent ONLY to the actor and never persisted to `last_turn`.

Host control writes (round advance, match finish) go through
`/.netlify/functions/submit-turn`; that endpoint accepts only those two
actions and is host-only.

### Migration from the v1 (client-authoritative) trust model

The v2 protocol changes the state shape (hands/deck redacted) and the
endpoint contract (per-action instead of full-state commits). In-progress
games from v1 will throw on the next action. Wipe them once after deploying:

```sql
-- Run once via the Neon SQL Editor. Cascades to room_seats + games.
DELETE FROM rooms WHERE status IN ('lobby', 'playing');
```

Players hitting an already-deleted room get a friendly "room gone" toast.

## Disconnect handling

- **Minimal:** if a player drops mid-turn, their turn waits. The host can
  Archive the table (Online tab → swipe row) to end the game for everyone.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Online play isn't available" on the Online tab | Identity widget didn't load (offline, or Identity not enabled on the site). |
| 401 from any function | Not signed in, or Identity not enabled. |
| 500 mentioning `NETLIFY_DATABASE_URL` / "connection string is not provided" | Netlify DB not enabled, or the site wasn't redeployed after enabling it (the env var is injected at deploy time). Re-trigger a deploy. |
| Functions work but no tables | Run the schema SQL from §3 in the Neon SQL Editor. |
| Polls seem to return stale state | Make sure the deployed `sw.js` is v39+ (it bypasses `/.netlify/functions`). Bump the cache and refresh. |
| Existing in-progress online game stuck after v2 deploy | Run the migration SQL above (`DELETE FROM rooms WHERE status IN ('lobby', 'playing')`). v1 state isn't compatible with the new server-authoritative protocol. |

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

After Identity and the DB are enabled, **sign in once** on the site, then hit:

```
https://<your-site>/.netlify/functions/setup-db
```

It creates the `users`, `rooms`, `room_seats`, and `games` tables. Every
statement is `IF NOT EXISTS`, so it's safe to re-run. (You can also run the SQL
by hand from the Neon console if you prefer — see `setup-db.mjs` for the exact
DDL.) A `{ "ok": true }` response means you're set.

## 4. Play

Open Benny → **Online** tab → **Sign in** → **Create table** (or **Join by
code** / pick a public table). Share the 5-character code with friends. The host
presses **Start game** once at least two players have joined.

---

## Local development (optional)

To run the functions + DB locally you need the Netlify CLI:

```
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
-- Run once via the Neon console or `netlify functions:invoke setup-db`-style
-- shell. Cascades to room_seats + games.
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
| Functions work but no tables | Run `/.netlify/functions/setup-db` once while signed in. |
| Polls seem to return stale state | Make sure the deployed `sw.js` is v39+ (it bypasses `/.netlify/functions`). Bump the cache and refresh. |
| Existing in-progress online game stuck after v2 deploy | Run the migration SQL above (`DELETE FROM rooms WHERE status IN ('lobby', 'playing')`). v1 state isn't compatible with the new server-authoritative protocol. |

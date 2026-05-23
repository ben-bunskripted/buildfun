# Benny Online Multiplayer — Netlify Setup

Benny's online mode runs entirely on Netlify: the static frontend (unchanged,
no build step) talks to a small **Netlify Functions** API, which reads/writes a
**Netlify DB** (Neon Postgres). Sign-in is **Netlify Identity** (Google + email).

Local play (Multiplayer / Solo vs CPU / Scoring) needs none of this and keeps
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

## v1 limitations (deliberate)

- **Trust model:** the full state (including hands) is shared with every client.
  Server-side move validation and hand redaction are planned follow-ups — both
  are cheap later because `game.js`/`rules.js` are pure and importable in a
  function.
- **Minimal disconnect handling:** if a player drops, their turn simply waits.
- **No online profile stats yet:** online matches don't fold into the local
  per-player achievement/stat store (each device would otherwise record every
  opponent under its own local profiles).
- **Host is the single authority** for advancing rounds and ending the match.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Online play isn't available" on the Online tab | Identity widget didn't load (offline, or Identity not enabled on the site). |
| 401 from any function | Not signed in, or Identity not enabled. |
| 500 mentioning `NETLIFY_DATABASE_URL` / "connection string is not provided" | Netlify DB not enabled, or the site wasn't redeployed after enabling it (the env var is injected at deploy time). Re-trigger a deploy. |
| Functions work but no tables | Run `/.netlify/functions/setup-db` once while signed in. |
| Polls seem to return stale state | Make sure the deployed `sw.js` is v39+ (it bypasses `/.netlify/functions`). Bump the cache and refresh. |

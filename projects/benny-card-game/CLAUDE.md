# Benny — Project Guide

A card game (14 rounds, 1 wildcard). Static web app: vanilla ES modules, no
build step, served from this directory. Online multiplayer adds a thin
Netlify Functions + Neon Postgres backend at the repo root — the client
stays buildless.

## Run

```sh
python -m http.server 8000
```

Open `http://localhost:8000` for hot-seat modes. For Online mode
(Identity, Functions, DB), run `netlify dev` from the repo root and see
[../../ONLINE_SETUP.md](../../ONLINE_SETUP.md). Browser target:
**Safari 14.1+ / Firefox 103+** (modern features used unconditionally —
`inset` shorthand, `replaceChildren`, `100dvh`, `backdrop-filter`,
pointer events).

## Layout

```text
benny-card-game/
├── index.html              # all screens (start, online lobby, reveal, pass, play,
│                           #   scoring, round-end, match-end) + modals
├── css/styles.css          # single stylesheet
├── manifest.webmanifest    # PWA manifest
├── sw.js                   # service worker (cache-first; bypasses /.netlify/functions)
├── js/
│   ├── main.js             # UI controller, screen routing, event wiring, boot
│   ├── cards.js            # deck model + card renderer (two render modes — see below)
│   ├── game.js             # multiplayer/CPU match state machine + No Way Out
│   ├── scoring.js          # scoring-only match state
│   ├── rules.js            # validateNewSet / validateAddition / validateSwap (pure)
│   ├── ai.js               # CPU planTurn — enumerates plays, picks by difficulty
│   ├── dragdrop.js         # pointer-event hand reorder (long-press on touch)
│   ├── rng.js              # randomInt + Fisher-Yates
│   ├── storage.js          # localStorage: per-mode match slots + user prefs
│   ├── profiles.js         # persistent per-player profiles (lifetime stats + history)
│   ├── achievements.js     # registry + pure evaluators run at match end
│   ├── tutorial.js         # first-time tutorial driver (pre-seeded deck + coach)
│   ├── net.js              # online transport + Netlify Identity wrapper
│   └── online.js           # online session controller (lobby, turn commit, replay)
└── assets/
    ├── favicon.png         # B-card art — favicon + apple-touch-icon + top-bar logo
    ├── logo-bg.png         # full Benny banner — start-screen hero
    ├── wildcard.png        # standalone wild banner art (project card / share previews)
    ├── icon-{192,512}-v3.png            # PWA install icons (transparent, versioned)
    ├── icon-{192,512}-maskable-v3.png   # PWA maskable variants
    ├── screenshot-{wide,narrow}.png     # PWA install previews
    └── cards/              # Bridge-size SVG cards (212×329 viewBox, ratio ~0.644).
                            # 52 used (rank+suit, "10" → "T", e.g. AS.svg, TC.svg).
                            # Backs/jokers (1B/2B, 1J/2J, "Back (n)") are unused —
                            # card backs are CSS-built via .card.back in styles.css.
```

Online backend (at the repo root — not inside this directory):

```text
netlify.toml                # publish=".", functions dir, /api/* → /.netlify/functions/*
netlify/functions/
├── _lib.mjs                # db() + getUser() + password hash + room-code maker
├── _engine.mjs             # server-side engine wrapper: applyAction() + redactStateForSeat()
│                           #   (re-exports browser engine from projects/benny-card-game/js/)
├── auth-sync.mjs           # POST: upsert users row from Identity JWT
├── create-room.mjs         # POST: host a new room (public/private, password optional)
├── join-room.mjs           # POST: take a seat in a room
├── list-rooms.mjs          # GET:  public lobby-state rooms
├── my-rooms.mjs            # GET:  signed-in user's active tables (resume affordance)
├── leave-room.mjs          # POST: drop a seat
├── start-game.mjs          # POST: host signal to deal; server shuffles + deals from room_seats
├── get-room.mjs            # GET:  poll endpoint, supports ?wait=1 long-poll; returns redacted state
├── apply-action.mjs        # POST: server-authoritative move commit; validates + applies via engine
├── submit-turn.mjs         # POST: host control writes (advanceRound / finishMatch only)
└── end-game.mjs            # POST: host-only, hard-deletes the room (cascade)

# Schema lives in ONLINE_SETUP.md §3 (run once via Neon SQL Editor).
package.json                # @netlify/neon + drizzle-orm + drizzle-kit
drizzle.config.ts           # schema location + connection URL (NETLIFY_DATABASE_URL)
ONLINE_SETUP.md             # operator setup notes
```

## Card rendering — two modes

Set at boot from `loadPrefs().cardStyle`, toggled on the start screen, persisted under `benny:prefs:v1`.

- **modern** (default): `<img src="assets/cards/{rank}{suit}.svg">` — the full pre-rendered card.
- **classic**: DOM-built — corner rank+suit (Cambria glyph for the suit), pip-grid face from `PIP_LAYOUT`, and detailed J/Q/K character SVGs (Knave with feathered cap + sword hilt, Queen with tiara + rose, King with imperial crown + scepter).

Both modes share the same outer `.card` div (size, shadow, hover/selected/dragging/just-drawn states). The CSS rules for `.card-art` and `.card .corner/.face/.pip/.portrait` target disjoint inner elements so they coexist without conflict.

`renderCard(card, opts)` opts: `{ wild, represents: {rank, suit}, className }`. The underlying art is always the actual card (the wildcard itself when `wild` is true). When `represents` is set, the represented rank+suit is shown inside the wild banner so you can see what the wildcard stands in for.

In modern mode `renderCard` also tags the element with `is-modern` — CSS uses that class to render the card unclipped (so the SVG's intrinsic corner rank/suit indicators aren't sliced off by the outer 3mm border-radius).

## Wildcard banner

DOM-built gold plaque (`<div class="wild-banner"><span class="wild-banner-label">WILD</span><span class="wild-banner-rep">…</span></div>`), centred, rotated −10°. The `wild-banner-rep` line only renders when `opts.represents` is set, showing e.g. `7♥`. Sized as a fraction of `--card-w` so it scales with the card.

## Theme

Navy palette matching `logo-bg.png`. CSS variables in `:root`:

- `--bg-1: #0a1a3a`, `--bg-2: #142a5a`, `--bg-3: #0d1e3d`
- `--felt: radial-gradient(ellipse at top, #1e3a6e, #0d1e3d, #06122a)`
- `--accent: #4a90e2` / `--accent-deep: #1f5fa0` (primary buttons, selections, reel marker)
- `--gold: #f5c451` / `--gold-deep: #c9963a` (wild badge, just-drawn outline)
- `--danger: #d96a5b` (unused so far but available)
- `theme-color` meta = `#0d1e3d`

Cards stay white; wild banner stays gold; danger stays red. No green anywhere.

## Card-size preference

`--card-w` / `--card-h` are normally driven by breakpoints. The user-facing
S/M/L/XL setting writes a `data-card-size` attribute on `<html>`; the
stylesheet has `[data-card-size="s"]` … `[data-card-size="xl"]` selectors
that override the breakpoint defaults. `"m"` clears the override and falls
back to the breakpoint sizes. Stored as `prefs.cardSize`. The same
segmented control appears on the start screen and inside the play-screen
hamburger menu — both write through `setCardSize()`.

## Hand layout — fan vs spread

`prefs.handFanned` toggles between two layouts:

- **Fanned** (default): cards overlap heavily and tilt per-card with a
  per-card vertical lift, producing a real fan.
- **Spread**: cards are spaced out with minimal overlap, no rotation.

`layoutHand()` reads the pref and the current viewport, recomputes the
overlap so the hand fits the bottom bar, and applies tilt + lift. It runs
on every render, on resize, after drag completes (so the fan re-fits the
remaining cards), and after a card-size change.

## Persistence

Three distinct keys, each owned by a different module:

- `benny:match:v1:<mode>` (in `storage.js`) — one slot per local mode
  (`multiplayer`, `cpu`, `scoring`), shape `{version, savedAt, mode,
  state: serialize(state), ui: {mode}}`. Saved on every state-changing
  action (`persist()` is called throughout `main.js`). A one-time
  migration folds a pre-per-mode `benny:match:v1` blob into its
  matching slot then deletes the legacy key.
- `benny:prefs:v1` (in `storage.js`) — `{cardStyle, cardSize, handFanned,
  animateCpu, hideTutorialLink, …}` and any future user preferences.
  Outlives matches.
- `benny:players:v1` (in `profiles.js`) — per-player lifetime profiles,
  keyed by `name.trim().toLowerCase()` so casing variants share a
  record. Holds `{stats, achievements[], matchHistory[]}`. Folded in at
  match-end via `recordMatch()`. **Local profiles aren't recorded for
  online matches yet.**

`hasSnapshot(mode)` + `load(mode)` + `loadAll()` drive the resume banner
on the start screen and the overwrite-confirmation modal. The banner
labels the most recent saved match with its mode name.

## Match-event log

`game.js` state carries a `matchEvents: {opens, discards, rounds}` slice used only by the achievement evaluator at match-end. Populated by `placeNewSet` (first time a player opens in a round), `discard` (every discard, with `wasWild` flag), and `finalizeRoundScoring` (per-round meta: winner, dealer, `openedOrder`, `winnerWildsOnTable`). Scoring mode emits the same `rounds` shape with `openedOrder: null` so the evaluator can branch on "no card detail available". When a run is *added to* by someone other than the owner, the added cards are credited to the adder (in their meld history) AND counted toward the owner's run-length stats — see the credit-additions changes in game.js.

## No Way Out

`isNoWayOut(state)` checks each player's hand against the top of the discard
and the deck top to see whether *anyone* could legally open a set/run, add
to an existing meld, or swap a wildcard if it were their turn. If no legal
move exists for anyone and the deck is empty, the round ends as a draw via
`finalizeNoWayOut(state)`: everyone scores their full hand (no winner
zero-score), and the round-end screen shows a "No Way Out" banner instead
of a winner. The dealer-slot reveal still runs when scoring mode picks
Random, so the visual rhythm matches the dealt modes.

## PWA / offline

Benny is an installable PWA scoped to `./` (so it's self-contained inside `projects/benny-card-game/` and doesn't claim the buildfun homepage).

- `manifest.webmanifest` — `display: standalone`, portrait, navy theme/background. Icons at `assets/icon-192-v3.png` and `assets/icon-512-v3.png` plus maskable variants (declared `"any maskable"` so Android adaptive cropping keeps the B visible). Filenames are versioned (`-v3`) so installed PWAs pick up the new launcher art when icons change. Icons are transparent — no navy plate.
- `sw.js` — cache-first service worker. On install, pre-caches the full shell: HTML, CSS, all JS modules (including `tutorial.js`, `net.js`, `online.js`), the asset PNGs, both icons + maskable variants, screenshots, and all 56 card SVGs. POSTs pass through (so the Netlify feedback form still works). Offline navigations fall back to `./index.html`. **`/.netlify/functions/*` and `/api/*` are bypassed entirely** — online polls must always hit the network or the game would freeze on stale state. Registered at end of `index.html` after the main module loads.

**Bump the cache version on every deploy that changes a shell file.** The `CACHE = "benny-vN"` constant at the top of `sw.js` is the cache key; the activate handler deletes any cache whose key doesn't match. Bumping is what forces installed clients to re-fetch updated JS/CSS/assets.

**Update banner**: install doesn't `skipWaiting` automatically. When a new SW is in the `waiting` state, the page shows a "Refresh to update" banner. Click → page posts `SKIP_WAITING` to the worker → activate → reload.

## Save & exit

Top bar of both the play and scoring screens has a **Save & exit** pill (`#play-exit-btn` / `#scoring-exit-btn`). Calls `exitToStart()` which:

1. Calls `persist()` (no-op if already current).
2. Drops in-memory `state`, clears `ui.selectedIds`.
3. Re-renders the resume banner, shows `screen-start`.

The save itself is automatic — this button is just the "stop and walk away" affordance. Online matches save server-side, so this is a no-op outside of clearing local UI.

## Overwrite confirmation

`onStartMatch()` checks `hasSnapshot(mode)` before kicking off any of `startMultiplayerMatch / startSoloMatch / startScoringMatch`. Per-mode slots mean overwrites are scoped — starting a Solo game prompts only if a Solo save exists, not a Scoring one. If a snapshot exists, `#modal-confirm` is invoked via `showConfirm({...})`. Confirm → `storageClear(mode)` then start. Cancel → abort. The softer resume banner on the start screen is still the first option presented.

## Rule: one number set per rank on the table

`placeNewSet` (game.js) rejects creating a number set whose rank already exists anywhere on the table (any player's section). Reason: with wildcards in the existing set, a parallel set would put >4 cards representing that rank on the table. The check is rank-only (`s.type === "number" && s.rank === arrangement.rank`); within-set count is still capped at 4 by `validateNewSet` and `validateAddition`.

`ai.js:enumerateNewSets(hand, wildRank, table)` filters out plays of ranks already in `table` so the CPU never offers an illegal play.

## Card zoom (hover / long-press)

`setupCardZoom()` (main.js, called at boot) attaches document-level listeners:

- Desktop: `mouseover`/`mouseout` on any `.card` *that isn't* `.in-hand`, `.back`, or `.drag-placeholder` clones the card into a fixed overlay (`.card-zoom`, 240×336 px, pointer-events: none so it doesn't block underlying clicks).
- Touch: 450 ms timer started on `touchstart`; cancelled if `touchmove` exceeds 8 px or `touchend`/`touchcancel` fires.

Scope: melds (own + others'), the discard pile. Hand cards are intentionally excluded — they're already legible and need to remain interactive.

## Hand reorder (drag/drop)

`dragdrop.js` uses pointer events with two activation paths:

- Mouse: arm on `pointerdown`, switch to drag after 6 px movement.
- Touch: long-press (220 ms) before claiming the gesture, so short taps and horizontal scrolls in the hand still work.

The lifted card is **reparented to `<body>`** during drag so `position:fixed` is honored relative to the viewport (avoids transformed-ancestor breakage on iOS), and `setPointerCapture` is re-acquired on the relocated node so the pointer event stream keeps targeting it. The original slot is left in place as an invisible placeholder; the rest of the fan re-lays out around the gap so the drop target is always clear. On drop, the card is re-parented back into the hand and the fan re-fits.

`window.addEventListener("pointermove", ..., { passive: false })` so we can `preventDefault` during an active drag. A short post-drag click suppression prevents the upcoming click from toggling card selection.

The drag also accepts the discard pile and other players' melds as drop targets, so you can drag-to-discard or drag-to-add without going through the menu.

## Tutorial

`tutorial.js` runs an opt-in walkthrough on first launch (and on demand from the start panel). It seeds the top of round 1's deck so the deal is deterministic — the human gets a 5-5-5 set + a 6-7-8-A run after one draw — then attaches coach balloons that anchor to the top of the viewport and highlight the next UI element to interact with. `main.js` calls `tutorial.notify(event, payload)` at every action site (`draw`, `select`, `placeSet`, `discard`, …); the tutorial advances when the expected event arrives. A "Skip tutorial" button lives on the coach, and a "Hide" link next to the start-panel link dismisses the prompt forever (stored in prefs).

## Online multiplayer

`js/online.js` is the session controller; `js/net.js` is the transport. Together they bolt a 4th mode onto the existing engine without duplicating any game logic.

### Auth

Netlify Identity widget loaded as a classic script (`<script src=".../netlify-identity-widget.js">`) so `window.netlifyIdentity` exists before `main.js` (a deferred module) boots. `net.initIdentity()` wires `init` / `login` / `logout` events and resolves with the mapped user. JWTs are fetched per-request via `user.jwt()` and sent as `Authorization: Bearer …`; Netlify Functions resolve them via `context.clientContext.user`. The card-style preference is gated behind being signed in (so it follows the user across devices later, even though storage is still local for now).

### Backend (Netlify Functions + Neon Postgres)

Tables (schema lives in ONLINE_SETUP.md §3; create once via the Neon SQL Editor):

- `users (uid PK, display_name, created_at)` — populated by `auth-sync` on first sign-in; canonical source for seat display names (see `_lib.mjs:canonicalDisplayName`).
- `rooms (id PK = join code, name, host_uid, visibility, password_hash?, status, max_players, …)`. `password_hash` is PBKDF2-SHA256 / 210k iterations (`_lib.mjs:hashPassword`); the legacy single-round-SHA-256 format is still accepted by `verifyPassword` for any pre-cutover rows.
- `room_seats (room_id, seat_index, uid, display_name, connected, …)` PK on (room_id, seat_index). `display_name` is set by the server from `users.display_name`; client-supplied display names are ignored.
- `games (room_id PK, seq, current_seat, status, state JSONB, last_turn JSONB, updated_at)`. State is server-authoritative; reads through `get-room` / `apply-action` are always redacted for the caller's seat.
- `rate_limit_log (uid, endpoint, ts)` — backs `_lib.mjs:rateLimit`. Sliding-window per-uid/per-endpoint counter; budgets defined in `_lib.mjs:RATE_BUDGETS`.

Join codes use an unambiguous alphabet (no 0/O/1/I), generated in `_lib.mjs:makeRoomCode`.

`@netlify/neon` is the SQL client. Choosing it (vs `@netlify/database`) is what tells Netlify to provision the database and inject `NETLIFY_DATABASE_URL` on deploy — `db()` in `_lib.mjs` lazily calls `neon()` which reads that env var.

### Polling (`get-room` + long-poll)

`net.js` runs a single in-flight, self-rescheduling poll loop. The `waitFn` consulted per tick decides whether to ask the server to long-poll: in the lobby roster changes don't bump `games.seq`, so we short-poll (1500 ms); once status flips to `playing`, we ask for `?wait=1` and the function holds the request up to ~9 s, polling the row every 600 ms, until a newer seq appears. That drops perceived turn latency from ~750 ms to ~50 ms.

### Turn commits + optimistic concurrency

Every game move goes through `apply-action.mjs` as a typed action
(`drawDeck`, `drawDiscard`, `play`, `add`, `swap`, `discard`). The server
holds the canonical state and applies each action through the same
`game.js`/`rules.js` engine the client uses — clients never write state
directly. The endpoint enforces:

- Auth: caller must hold a seat in the room.
- Turn: `seat === current_seat`.
- Optimistic concurrency: `expectedSeq === games.seq`. Stale → 409 with the
  caller's redacted state attached so they can adopt and retry.

Host control writes (round advance / match finish) live in `submit-turn.mjs`
and only accept `{action: "advanceRound" | "finishMatch"}`. Same auth + seq
checks; no general state writes.

### Hand + deck redaction

`_engine.mjs:redactStateForSeat(state, seat)` deep-clones the canonical state
and replaces every other player's `hand` with same-length opaque
placeholders (`{id: "hidden-...", hidden: true}`), and replaces `deck` the
same way. The caller's own hand is left intact. Every endpoint that returns
state runs through this — `get-room`, `apply-action`, `join-room` (rejoin),
`submit-turn` (stale 409s). The drawn card from `drawDeck` is sent only on
the actor's `apply-action` response (under `drawnCard`); it's never
persisted in `last_turn` so spectators never see it.

### Replay (spectator side)

When the poll loop notices `lastTurn.seat !== mySeat`, it routes the new
action(s) through `replayRemote()`, which:

1. Begins a turn on the local state mirror (only on the first delta of a new turn).
2. Walks the new tail of `lastTurn.actions`, calling `cb.stepRemoteAction(action)` for each.
3. Paces inter-action delays from the actor's `at` timestamps (capped at 1500 ms so an AFK actor doesn't freeze the spectator).
4. Returns `{isDone, replayedCount, lastActionAt}` so the next poll only animates the new tail. Final discard flips `isDone` true; we then adopt the authoritative server state and `route()` (which may hand the turn to us).

The actor's hand is redacted on the spectator side, so before each engine
apply `stepCpuAnimated` calls `patchActorHandFromAction(action, actorIdx)`.
That function inspects the action payload (`discard.card`, `swap.natural`,
`play.arrangement.cards`, `add.arrangement.added` — all *public-info* cards
that are leaving the actor's hand) and splices each real card into the
actor's hidden hand by replacing one placeholder. The engine can then find
the card by id and animate normally. Cards that never become public (e.g.,
the card drawn from the deck) stay hidden — the spectator sees a
face-down ghost.

### Mid-turn refresh recovery (actor side)

If the actor refreshes the page, their next `get-room` poll lands the server's
current state (with their own hand visible) and the partial `last_turn.actions`
list. Because every action is server-committed before the actor's UI updates,
there's no client-only "in flight" state to recover — whatever the actor saw
last is what the server stored.

### Lifecycle: archive, end-game, room cleanup

Two destructive actions, both server-authoritative:

- **Archive (any seat)** — `leave-room` with `{archive: true}`. Removes the caller's seat AND decrements `rooms.max_players` by 1. The room auto-deletes when `max_players < 2`, when `room_seats` becomes empty, or when the host archives an in-progress game (the table can't continue without its host).
- **End game (host only)** — `end-game.mjs`. Hard-deletes the `rooms` row (cascades to `room_seats` + `games`). Every other participant's next poll hits 404 → `net.startPolling`'s `onError` callback fires → `online.js:onPollError` tears down the session → `main.js:handleOnlineRoomGone` toasts and routes them back to the start screen.

Both surface in two places on the client:

- **"Your tables" list** (start-screen Online tab) — each row is a swipe-to-reveal panel. Drag left ≥ half the panel width to open; tap **Archive** (any) or **End** (host). The swipe is built in `main.js:attachRowSwipe` and uses pointer events with a 6 px activation threshold + an x/y axis lock so vertical scrolls aren't claimed. Only one row can be open at a time.
- **In-match hamburger menu** — "Archive & leave" (everyone in a session) and "End game" (host only). Both items carry the `.online-only` class and are toggled by `syncOnlineMenuVisibility()` on each menu open. The "End game" item also carries `.danger-item` for the red colour.

### Per-user table cap

A signed-in user can hold at most `MAX_ACTIVE_ROOMS_PER_USER` (10) seats across non-finished rooms. `create-room` and `join-room` both run `countActiveRoomsForUser` from `_lib.mjs` before allocating a new seat; hitting the cap returns `409 {code: "table-cap", cap}`. The client checks for that `code` and surfaces a confirm modal pointing the user to the "Your tables" list to archive an old one (existing-seat rejoins bypass the check, so a user at the cap can still reopen tables they're already in).

### Host pre-commit: roster must be full

`start-game.mjs` rejects with 409 unless `room_seats.count == rooms.max_players`. The lobby's Start button is also hidden client-side until that condition is true (`main.js:renderLobbyRoster`), but the server check is the source of truth — useful since `max_players` can drop after the lobby is rendered (someone archives while others wait).

## Conventions

- Pure rule validation in `rules.js`; state mutation only in `game.js` / `scoring.js`.
- `renderCard` and `renderCardBack` are the only places that touch card markup; everything else manipulates the `.card` div from the outside (classes, position).
- `persist()` is called at every state transition in `main.js` — don't skip it on new code paths.
- Online actions go through `online.applyOnlineOrLocal({action, localApply})` inside each action handler in `main.js`. When online, the action is committed server-side via `apply-action.mjs` and the post-state (redacted for the caller) is adopted. When offline, the `localApply` callback runs the engine directly. Same code path serves both modes.
- Toast errors via `toast(message)` for user-facing rule rejections; rule functions return `{ ok: false, reason }`.
- CSS variables for theme; raw hex only where the value is one-off (and even those got swapped during the theme conversion).
- No build step on the client. The functions directory uses `esbuild` (configured in `netlify.toml`) — that's Netlify's bundler, not ours, and there's still nothing to install before serving the static site.

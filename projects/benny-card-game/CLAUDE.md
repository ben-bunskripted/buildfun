# Benny — Project Guide

A card game (14 rounds, 1 wildcard). Static web app: vanilla ES modules, no
build step, served from this directory.

## Run

```sh
python -m http.server 8000
```

Open `http://localhost:8000`. Browser target:
**Safari 14.1+ / Firefox 103+** (modern features used unconditionally —
`inset` shorthand, `replaceChildren`, `100dvh`, `backdrop-filter`,
pointer events).

## Tests

Tooling lives at the **repo root** (`../../`), not in this directory — the
client stays buildless; tests are dev-only.

```sh
npm test            # Vitest: unit + DOM (jsdom) — runs in Node, fast
npm run test:e2e    # Playwright: drives index.html in a real browser
```

- **Vitest** (`vitest.config.js`) covers `tests/unit` (rng, cards, rules, game
  incl. No Way Out, scoring, ai self-play, achievements, profiles) and
  `tests/dom` (jsdom: storage, `renderCard`). Shared card/meld builders are in
  `tests/helpers.js`.
- **Playwright** (`playwright.config.js`, specs in `tests/e2e`) boots the static
  client via `python -m http.server` and exercises the start → deal → play flow.
  `tests/e2e/fixtures.js` seeds a username (skips the welcome modal) and the
  config sets `serviceWorkers: "block"` (the PWA SW's first-activation
  `controllerchange` reloads the page and would race the tests).
- **Browser pinning:** Playwright must match the pre-baked browser build in
  `/opt/pw-browsers` (the CDN is firewalled, so `playwright install` can't fetch
  others). Build 1194 ⇒ `@playwright/test@1.56.x`. Only Chromium is pre-baked;
  WebKit/Firefox are opt-in via `PW_ALL_BROWSERS=1` where installed.

## Layout

```text
benny-card-game/
├── index.html              # all screens (start, reveal, pass, play,
│                           #   scoring, round-end, match-end) + modals
├── css/styles.css          # single stylesheet
├── manifest.webmanifest    # PWA manifest
├── sw.js                   # service worker (cache-first shell + offline fallback)
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
│   └── tutorial.js         # first-time tutorial driver (pre-seeded deck + coach)
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
  match-end via `recordMatch()`.

`hasSnapshot(mode)` + `load(mode)` + `loadAll()` drive the resume banner
on the start screen and the overwrite-confirmation modal. The banner
labels the most recent saved match with its mode name.

## Match-event log

`game.js` state carries a `matchEvents: {opens, discards, rounds, setsPlayed, pickups, moveLog}` slice. `opens`/`discards`/`rounds`/`setsPlayed` feed the achievement evaluator at match-end; `discards` and `pickups` are also read mid-game by the hard CPU's discard defence (`pickups` — every `drawFromDiscard`, with rank/suit — is public information, so the AI isn't peeking). Populated by `placeNewSet` (first time a player opens in a round), `discard` (every discard, with `wasWild` flag), `drawFromDiscard` (pickups), and `finalizeRoundScoring` (per-round meta: winner, dealer, `openedOrder`, `winnerWildsOnTable`). Scoring mode emits the same `rounds` shape with `openedOrder: null` so the evaluator can branch on "no card detail available". When a run is *added to* by someone other than the owner, the added cards are credited to the adder (in their meld history) AND counted toward the owner's run-length stats — see the credit-additions changes in game.js.

### Downloadable per-match transcript (`moveLog`)

`moveLog` is a single **ordered** transcript of every move in the match — one entry per `drawDeck`, `drawDiscard`, `play`, `add`, `swap`, `discard`, plus `roundStart`/`roundEnd` markers — appended by `logMove()` from inside each engine action in `game.js`. Each entry is self-describing: `{seq, round, wildcardRank, type, playerIdx, …}`. It records **public information only** — a `drawDeck` entry notes that a draw happened but **never** the card's identity. Melds, discards and discard-pile pickups are public (they're on the table / face-up), so their card detail is logged.

At match-end the log flows through `buildMatchSummary` (as part of `matchEvents`) into each player's profile: `recordMatch` (profiles.js) stores `moveLog`, `players` (names by index), `playerIdx` and `roundHistory` on the `matchHistory` row. To bound localStorage the heavy fields are kept only on the most recent `LOG_DETAIL_CAP` (20) rows — older rows keep their summary stats but shed the log. The **Recent matches** table (achievements/profile screen) renders a per-row **Download** button (`renderProfileRecent` → `downloadMatchLog` → `buildMatchLogText` in main.js) that emits a readable `.txt` transcript; rows whose log has been trimmed show a muted dash instead.

## Number-set sizing

A number set holds at most four *naturals* (one per suit — the duplicate-suit
guard in `validateNewSet` / `validateAddition` enforces this), but wildcards
can pad it beyond four. So a Benny can always be laid onto a complete
four-of-a-kind. There is intentionally no overall cap on set size.

## No Way Out

`isNoWayOut(state)` (game.js) declares the round a dead draw only in the one
genuinely unwinnable endgame that survives the uncapped-set rule — since a
reachable Benny normally rescues a stuck round. It fires only when **all four**
of these hold, and **only after every player has completed ≥ 3 draw-and-discard
cycles this round** (`NO_WAY_OUT_MIN_CYCLES`; tracked per player as
`drawsThisRound`, reset each round, incremented on every `drawFromDeck` /
`drawFromDiscard`). The gate keeps an early, transient lull from being mistaken
for a real deadlock:

1. **Nobody can open** — every player is at ≤ 2 cards. A hand only ever shrinks
   (draw 1 / discard 1 each turn; it grows only by laying cards), so a hand
   already ≤ 2 can never reach the 4 needed to open.
2. **All four wildcards are buried in melds** — none sits in a hand, the deck,
   or the discard, so no Benny can be drawn back into play.
3. **No buried wildcard can be swapped free** — every melded wildcard's
   matching natural is itself already on the table, so no legal swap exists to
   pull a Benny back out (`swapFreeableWildcards` returns empty).
4. **No reachable natural extends any meld** — every run is capped/blocked at
   both ends and every number set is missing only already-melded suits
   (`validateAddition` rejects every off-table natural against every meld).

When all hold, the round ends as a draw via `finalizeNoWayOut(state)`:
everyone scores their full hand (no winner zero-score) and the round-end screen
shows a "No Way Out" banner. The check runs after each discard in `main.js`.

## PWA / offline

Benny is an installable PWA scoped to `./` (so it's self-contained inside `projects/benny-card-game/` and doesn't claim the buildfun homepage).

- `manifest.webmanifest` — `display: standalone`, portrait, navy theme/background. Icons at `assets/icon-192-v4.png` and `assets/icon-512-v4.png` plus maskable variants (declared `"any maskable"` so Android adaptive cropping keeps the B visible). Filenames are versioned (`-v4`) so installed PWAs pick up the new launcher art when icons change — **always bump the `-vN` suffix when the icon bytes change; reusing a filename leaves Android's WebAPK on the old icon since it keys on the URL.** Icons are transparent — no navy plate.
- `sw.js` — cache-first service worker. On install, pre-caches the full shell: HTML, CSS, all JS modules (including `tutorial.js`), the asset PNGs, both icons + maskable variants, screenshots, and all 56 card SVGs. POSTs pass through (so the Netlify feedback form still works). Offline navigations fall back to `./index.html`. Registered at end of `index.html` after the main module loads.

**Bump the cache version on every deploy that changes a shell file.** The `CACHE = "benny-vN"` constant at the top of `sw.js` is the cache key; the activate handler deletes any cache whose key doesn't match. Bumping is what forces installed clients to re-fetch updated JS/CSS/assets.

**Update banner**: install doesn't `skipWaiting` automatically. When a new SW is in the `waiting` state, the page shows a "Refresh to update" banner. Click → page posts `SKIP_WAITING` to the worker → activate → reload.

## Save & exit

Top bar of both the play and scoring screens has a **Save & exit** pill (`#play-exit-btn` / `#scoring-exit-btn`). Calls `exitToStart()` which:

1. Calls `persist()` (no-op if already current).
2. Drops in-memory `state`, clears `ui.selectedIds`.
3. Re-renders the resume banner, shows `screen-start`.

The save itself is automatic — this button is just the "stop and walk away" affordance.

## Overwrite confirmation

`onStartMatch()` checks `hasSnapshot(mode)` before kicking off any of `startMultiplayerMatch / startSoloMatch / startScoringMatch`. Per-mode slots mean overwrites are scoped — starting a Solo game prompts only if a Solo save exists, not a Scoring one. If a snapshot exists, `#modal-confirm` is invoked via `showConfirm({...})`. Confirm → `storageClear(mode)` then start. Cancel → abort. The softer resume banner on the start screen is still the first option presented.

## Rule: one number set per rank on the table

`placeNewSet` (game.js) rejects creating a number set whose rank already exists anywhere on the table (any player's section). This keeps each rank to a single pile rather than scattering it across parallel sets. The check is rank-only (`s.type === "number" && s.rank === arrangement.rank`); the duplicate-suit guard in `validateNewSet` / `validateAddition` still keeps naturals to one per suit, but wildcards may pad a set past four cards.

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

## Conventions

- Pure rule validation in `rules.js`; state mutation only in `game.js` / `scoring.js`.
- `renderCard` and `renderCardBack` are the only places that touch card markup; everything else manipulates the `.card` div from the outside (classes, position).
- `persist()` is called at every state transition in `main.js` — don't skip it on new code paths.
- Each action handler in `main.js` runs the engine directly (e.g. `drawFromDeck(state)`, `discard(state, id)`) then persists and re-renders.
- Toast errors via `toast(message)` for user-facing rule rejections; rule functions return `{ ok: false, reason }`.
- CSS variables for theme; raw hex only where the value is one-off (and even those got swapped during the theme conversion).
- No build step — the static site is served as-is, nothing to install before serving.

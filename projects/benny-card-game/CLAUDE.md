# Benny — Project Guide

A hot-seat card game (14 rounds, 1 wildcard). Static web app: vanilla ES modules, no build step, served from this directory.

## Run

```
python -m http.server 8000
```

Open `http://localhost:8000`. Browser target: **Safari 14.1+ / Firefox 103+** (modern features used unconditionally — `inset` shorthand, `replaceChildren`, `100dvh`, `backdrop-filter`, pointer events).

## Layout

```
benny-card-game/
├── index.html              # all screens (start, reveal, pass, play, scoring, round-end, match-end) + modals
├── css/styles.css          # single stylesheet
├── js/
│   ├── main.js             # UI controller, screen routing, event wiring, boot
│   ├── cards.js            # deck model + card renderer (two render modes — see below)
│   ├── game.js             # multiplayer/CPU match state machine
│   ├── scoring.js          # scoring-only match state
│   ├── rules.js            # validateNewSet / validateAddition / validateSwap (pure)
│   ├── ai.js               # CPU planTurn — enumerates plays, picks by difficulty
│   ├── dragdrop.js         # pointer-event hand reorder (long-press on touch)
│   ├── rng.js              # randomInt
│   └── storage.js          # localStorage: match snapshot + user prefs (separate keys)
└── assets/
    ├── favicon.png         # gold "WILD" tile — favicon + apple-touch-icon + top-bar logo
    ├── logo-bg.png         # full Benny banner with cards + tagline — start-screen hero
    ├── wildcard.png        # gold tile drawn on top of any wildcard in play
    └── cards/              # 56 full-card SVGs (52 cards + 2 backs + 2 jokers unused)
                            # filename = rank+suit, "10" → "T" (e.g. AS.svg, TC.svg)
```

## Card rendering — two modes

Set at boot from `loadPrefs().cardStyle`, toggled on the start screen, persisted under `benny:prefs:v1`.

- **modern** (default): `<img src="assets/cards/{rank}{suit}.svg">` — the full pre-rendered card.
- **classic**: DOM-built — corner rank+suit (Cambria glyph for the suit), pip-grid face from `PIP_LAYOUT`, and detailed J/Q/K character SVGs (Knave with feathered cap + sword hilt, Queen with tiara + rose, King with imperial crown + scepter).

Both modes share the same outer `.card` div (size, shadow, hover/selected/dragging/just-drawn states). The CSS rules for `.card-art` and `.card .corner/.face/.pip/.portrait` target disjoint inner elements so they coexist without conflict.

`renderCard(card, opts)` opts: `{ wild, represents: {rank, suit}, className }`. When `represents` is set, the card art shows the *represented* card (used when a wildcard sits in a meld), with a wildcard tile overlaid via `.wild-banner`.

## Wildcard banner

Image overlay (`assets/wildcard.png`), centred, rotated −10°, 55% of card width on mobile, 82% at ≥720 px (≈50% larger on desktop). Renders over the underlying card art whenever `opts.wild` is true.

## Theme

Navy palette matching `logo-bg.png`. CSS variables in `:root`:

- `--bg-1: #0a1a3a`, `--bg-2: #142a5a`, `--bg-3: #0d1e3d`
- `--felt: radial-gradient(ellipse at top, #1e3a6e, #0d1e3d, #06122a)`
- `--accent: #4a90e2` / `--accent-deep: #1f5fa0` (primary buttons, selections, reel marker)
- `--gold: #f5c451` / `--gold-deep: #c9963a` (wild badge, just-drawn outline)
- `--danger: #d96a5b` (unused so far but available)
- `theme-color` meta = `#0d1e3d`

Cards stay white; wild banner stays gold; danger stays red. No green anywhere.

## Persistence

Two distinct keys in `storage.js`:

- `benny:match:v1` — `{version, mode, state: serialize(state), ui: {mode}}`. Saved on every state-changing action (`persist()` is called throughout `main.js`).
- `benny:prefs:v1` — `{cardStyle}` and any future user preferences. Outlives matches.

`hasSnapshot()` + `load()` drive the resume banner on the start screen and the overwrite-confirmation modal.

## Save & exit

Top bar of both the play and scoring screens has a **Save & exit** pill (`#play-exit-btn` / `#scoring-exit-btn`). Calls `exitToStart()` which:
1. Calls `persist()` (no-op if already current).
2. Drops in-memory `state`, clears `ui.selectedIds`.
3. Re-renders the resume banner, shows `screen-start`.

The save itself is automatic — this button is just the "stop and walk away" affordance.

## Overwrite confirmation

`onStartMatch()` checks `hasSnapshot()` before kicking off any of `startMultiplayerMatch / startSoloMatch / startScoringMatch`. If a snapshot exists, the existing `#modal-confirm` is invoked via `showConfirm({...})`. Confirm → `storageClear()` then start. Cancel → abort. The softer resume banner is still the first option presented when the user lands on the start screen.

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

`window.addEventListener("pointermove", ..., { passive: false })` so we can `preventDefault` during an active drag. A short post-drag click suppression prevents the upcoming click from toggling card selection.

## Conventions

- Pure rule validation in `rules.js`; state mutation only in `game.js` / `scoring.js`.
- `renderCard` and `renderCardBack` are the only places that touch card markup; everything else manipulates the `.card` div from the outside (classes, position).
- `persist()` is called at every state transition in `main.js` — don't skip it on new code paths.
- Toast errors via `toast(message)` for user-facing rule rejections; rule functions return `{ ok: false, reason }`.
- CSS variables for theme; raw hex only where the value is one-off (and even those got swapped during the theme conversion).
- No build step. Keep it that way.

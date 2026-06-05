# Sh!thead

The classic shedding card game, built as a buildless static web app (vanilla ES
modules, no build step) — a sibling project to Benny under `projects/`.

Get rid of all your cards. The last player still holding cards is the
**Sh!thead**.

## Run

```sh
python3 -m http.server 8000 --directory projects/shithead
# open http://localhost:8000
```

No install, no bundler. Modern-browser features are used unconditionally
(`replaceChildren`, `100dvh`, `backdrop-filter`, pointer events).

## Modes

- **Solo vs CPU** — 2–4 players, you against Easy / Normal / Hard bots.
- **Pass & Play** — hot-seat on one device, with a tap-to-continue handoff
  screen between players so hands stay hidden.
- **Online** — planned (phase 2); the engine is already written as a pure
  `applyAction(state, action)` reducer so it can run server-authoritative on the
  shared Netlify Functions + Neon backend, reusing Benny's accounts.

## Rules implemented

- Ranking 3 (low) → A (high). Lowest 3 starts (4 if nobody holds a 3).
- **Power cards** (each individually switchable in House rules — the default
  loadout is `2`, `10` and a reversing `8`):
  - `2` — reset the pile.
  - `10` — burn the pile (+ replay).
  - `7` — forces the next play ≤ 7 (else pick up). *Off by default.*
  - `8` — **reverse** the direction of play (default; with two players it
    bounces back so you go again) · **invisible** (see through to the card
    below) · **skip** the next player.
  - **Jokers** — adds 2 jokers (54-card deck). Playing one forces the next
    player to take the **whole pile**, unless they answer with a `3`, which
    passes that obligation down the line until someone without a `3` scoops it
    all. A `3` has no power of its own — it is purely a joker defence.
    *Off by default.*
  - Four-of-a-kind burns the pile (including completing it across turns).
- Pre-game swap phase (hand ↔ face-up), optional.
- Endgame: hand → face-up → face-down blind flips.
- A stalemate safeguard force-burns the pile if play stops making progress for a
  long stretch, so a degenerate weak-CPU bounce can never hang the game.

All of these are setup toggles on the start screen under **House rules**.

## Layout

```text
shithead/
├── index.html              # all screens (start, swap, play, over) + modals
├── css/styles.css          # single rainbow-theme stylesheet
├── manifest.webmanifest    # PWA manifest
├── sw.js                   # service worker (cache-first)
├── js/
│   ├── main.js             # UI controller, screen routing, CPU turn driver
│   ├── rules.js            # pure rules (requirement, canPlay, burns, …)
│   ├── game.js             # state machine + applyAction reducer
│   ├── ai.js               # CPU planTurn (easy/normal/hard) + swap heuristic
│   ├── cards.js            # deck model + card renderer (modern SVG / classic)
│   ├── rng.js              # crypto-backed shuffle
│   ├── storage.js          # localStorage: per-mode match slots + prefs
│   ├── profiles.js         # persistent per-player stats + history
│   ├── achievements.js     # registry + pure evaluators run at game end
│   └── sw-register.js      # service-worker registration
└── assets/
    ├── logo.png            # start-screen hero + homepage card
    ├── favicon.png         # favicon / apple-touch-icon / PWA icon source
    └── cards/              # 52 bridge-size SVG cards + 2 jokers (shared with Benny)
```

## Tests

Run from the repo root (`../../`):

```sh
npm test    # Vitest — engine rules, state machine, and CPU self-play
```

`tests/unit/shithead.*.test.js` cover the pure rules, the state machine
(playing, burning, pickups, blind flips, finishing), and full CPU-vs-CPU
self-play across every difficulty / player count to guarantee termination.

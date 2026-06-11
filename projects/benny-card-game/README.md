# Benny — card game

A 2-to-4-player card game. 14 rounds, lowest cumulative score wins. It's a
static site — no build step, no backend, no dependencies, just vanilla
ES modules.

## Modes

Pick one from the start screen:

- **Multiplayer** — the classic hot-seat experience. The device passes
  between humans; each turn is gated by a "Show hand" screen.
- **Solo** — one human plus 1–3 CPU opponents. Each opponent has
  its own difficulty (Easy / Medium / Hard). CPU turns either animate
  on the table or pop a recap card you tap through — configurable.
- **Scoring only** — companion for in-real-life play. The app deals
  nothing; you enter the winner and each loser's hand total per round,
  and it keeps cumulative scores across the 14 rounds.

In-progress matches in any mode persist to `localStorage` — each mode
keeps its own slot, so a paused Solo game won't get wiped when you start
a Scoring session. The resume banner on the start screen offers the most
recent saved match back.

## First-time tutorial

The first time you open Benny, a one-line "Try the tutorial" link
appears next to **Start match**. It deals a pre-seeded round against a
single CPU and walks through draw → play sets → discard with coach
balloons. Replay it any time from the bottom of the start panel.

## Settings

From the start screen or the top-bar hamburger inside a match:

- **Card size** — S / M / L / XL.
- **Fan vs spread** — fanned hand with per-card tilt, or spread out.
- **Card art** — modern (SVG) or classic (DOM-rendered, pip-grid).
- **Animate CPU moves** — on-table animation vs recap card.

## Run locally

From inside this folder:

```sh
python -m http.server 8000
```

Then open `http://localhost:8000` in your browser. (Any static file
server works — `npx serve`, `caddy file-server`, etc.)

## Cross-browser test plan

The game is mobile-first and targets the latest **Chrome**, **Safari**, and
**Firefox** on both desktop and mobile. To validate:

1. **Chrome desktop**
   - Open the site, start a 3-player match with the Random dealer.
   - Watch the slot-machine reel land on the chosen dealer.
   - Walk through a full round: dealer opens (no draw, optional plays,
     discard), each non-dealer draws + plays + discards.
   - Try playing a number set, a suited run, adding to a set, swapping a
     wildcard. Confirm a 5th card cannot be added to a number set with a
     wildcard already in it.
   - Confirm wildcard ambiguity prompt appears for `J-Q-K + WILD`.
   - Open DevTools — no console errors.

2. **Chrome Android / Firefox Android**
   - Same flow on a phone. Confirm the layout doesn't feel cramped, pips
     stay inside card edges, the bottom hand bar is sticky, and
     long-pressing a card lets you drag it to a new position.

3. **Safari desktop**
   - Same flow as Chrome desktop. Open Web Inspector — no console errors.

4. **Safari on iOS**
   - Walk the same round on an iPhone (real device strongly preferred).
   - Confirm:
     - Tap a card → selection lifts the card.
     - Long press + drag → reorders the card. (This is the most
       failure-prone interaction historically.)
     - Quick swipe → scrolls the hand horizontally without grabbing the
       card.
     - The slot-machine reel runs smoothly.
   - Connect Web Inspector — no console errors.

## Project layout

```text
benny-card-game/
├── index.html
├── manifest.webmanifest    # PWA manifest (installable, standalone)
├── sw.js                   # Service worker — cache-first shell + offline fallback
├── css/styles.css
└── js/
    ├── main.js             # UI controller, mode router, screen orchestration
    ├── game.js             # State machine (deal, draw, play, discard, scoring)
    ├── rules.js            # Set / run / addition / swap validation
    ├── ai.js               # CPU decision engine (Easy / Medium / Hard)
    ├── scoring.js          # Scoring-mode state machine (no engine, no deck)
    ├── tutorial.js         # First-time interactive tutorial
    ├── storage.js          # localStorage: per-mode match slots + prefs
    ├── profiles.js         # Lifetime per-player stats + match history
    ├── achievements.js     # Registry + evaluators run at match-end
    ├── cards.js            # Card model, deck, DOM renderer (pips, portraits)
    ├── dragdrop.js         # Hand reordering via pointer events (iOS-safe)
    └── rng.js              # crypto.getRandomValues + Fisher-Yates shuffle
```

## Rules summary

See the build spec inside the project history for the complete rules. The
key invariants the game enforces:

- 52-card deck per round, Fisher-Yates shuffle backed by
  `crypto.getRandomValues`.
- 14 rounds with wildcard rank rotating
  `A,2,3,4,5,6,7,8,9,10,J,Q,K,A`.
- Dealer opens with 8 cards, **no draw**, may play sets / add / swap, must
  discard. Subsequent turns: draw → optional plays → discard.
- Number sets hold at most four naturals (one per suit) but wildcards can
  pad them further, so a Benny can always join a four-of-a-kind. Suited runs
  use low or high Ace but never wrap. Pairs are rejected.
- A wildcard in an unambiguous run position auto-resolves; otherwise the
  player is prompted to choose.
- Cards left in hand at round end score face value (J=11, Q=12, K=13,
  A=14) — wildcards count 15 regardless. Round winner scores 0.
- **No Way Out**: the round ends as a no-winner draw (everyone scores
  their hand) only in a true deadlock — every player stuck at ≤2 cards,
  all four wildcards buried in melds with no swap to free them, and no
  reachable card able to extend any meld — and only after each player has
  taken at least 3 draw-and-discard turns that round.

## Notes

- No `Math.random` is used anywhere. Search the source — it isn't there.
- All cards in hand, on the discard pile, and inside melds use the same
  renderer, so styles stay consistent.
- Clubs and spades are both dark; they're differentiated by **pip shape**
  (clubs are rounded and heavy; spades are slim and pointed).

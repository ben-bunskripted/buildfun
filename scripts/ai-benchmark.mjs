// Head-to-head Benny CPU benchmark. Plays full matches through the real
// engine with a (possibly different) planner module per seat, so AI changes
// can be measured against a snapshot of the previous planner instead of
// eyeballed.
//
// Usage:
//   node scripts/ai-benchmark.mjs \
//     --seats hard:projects/benny-card-game/js/ai.js,hard:/tmp/benny-baseline-js/ai.js,hard:projects/benny-card-game/js/ai.js,hard:/tmp/benny-baseline-js/ai.js \
//     --games 200
//
// Each --seats entry is difficulty:plannerModulePath (the module must export
// planTurn). Seat assignments rotate every game to cancel position bias;
// results are aggregated per entry, not per seat.

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  createMatch, startNextRound, advanceToNextRound, beginTurn, isMatchOver,
  matchWinnerIndex, isNoWayOut, finalizeNoWayOut,
  drawFromDeck, drawFromDiscard, placeNewSet, addToSet, swapWildcard, discard,
  currentPlayer,
} from "../projects/benny-card-game/js/game.js";

function applyAction(state, a) {
  switch (a.type) {
    case "drawDeck": return drawFromDeck(state);
    case "drawDiscard": return drawFromDiscard(state);
    case "play": return placeNewSet(state, a.arrangement);
    case "add": return addToSet(state, a.setId, a.arrangement);
    case "swap": return swapWildcard(state, a.setId, a.positionIndex, a.naturalCardId);
    case "discard": return discard(state, a.cardId);
    default: throw new Error("unknown action " + a.type);
  }
}

function parseArgs(argv) {
  const out = { games: 200, seats: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--games") out.games = Number(argv[++i]);
    else if (argv[i] === "--seats") out.seats = argv[++i];
    else throw new Error("unknown arg " + argv[i]);
  }
  if (!out.seats) throw new Error("--seats is required (difficulty:modulePath, comma-separated, 2-4 entries)");
  return out;
}

const MAX_TURNS_PER_ROUND = 600; // hard stop for a pathological round

async function main() {
  const args = parseArgs(process.argv);
  const specs = await Promise.all(args.seats.split(",").map(async (s, i) => {
    const sep = s.indexOf(":");
    const difficulty = s.slice(0, sep);
    const path = s.slice(sep + 1);
    const mod = await import(pathToFileURL(resolve(path)).href);
    if (typeof mod.planTurn !== "function") throw new Error(path + " does not export planTurn");
    return { label: `#${i} ${difficulty} ${path}`, difficulty, planTurn: mod.planTurn };
  }));
  const n = specs.length;
  if (n < 2 || n > 4) throw new Error("need 2-4 seat entries");

  const tally = specs.map(() => ({ wins: 0, score: 0, planFailures: 0 }));

  for (let g = 0; g < args.games; g++) {
    // Rotate planners across seats so no entry owns a favourable position.
    const seatSpec = Array.from({ length: n }, (_, seat) => specs[(seat + g) % n]);
    const state = createMatch(
      seatSpec.map((sp, i) => `P${i}`),
      g % n, // rotate the opening dealer too
      { mode: "cpu", playerKinds: seatSpec.map(() => "cpu"), difficulties: seatSpec.map(sp => sp.difficulty) },
    );
    startNextRound(state);

    while (!isMatchOver(state)) {
      if (state.phase === "roundOver") { advanceToNextRound(state); continue; }
      let roundDone = false;
      for (let turn = 0; turn < MAX_TURNS_PER_ROUND && !roundDone; turn++) {
        beginTurn(state);
        const sp = seatSpec[state.currentPlayerIndex];
        const plan = sp.planTurn(state, sp.difficulty);
        for (const a of plan) {
          const r = applyAction(state, a);
          if (!r || !r.ok) {
            tally[specs.indexOf(sp)].planFailures += 1;
            break;
          }
          if (a.type === "discard" && r.wonRound) roundDone = true;
        }
        // Mirror main.js's fallback: if the plan stalled before discarding,
        // shed the last card so the match always progresses.
        if (!roundDone && state.phase === "canAct") {
          const me = currentPlayer(state);
          const r = discard(state, me.hand[me.hand.length - 1].id);
          if (r.ok && r.wonRound) roundDone = true;
        }
        if (!roundDone && isNoWayOut(state)) { finalizeNoWayOut(state); roundDone = true; }
      }
      if (!roundDone) finalizeNoWayOut(state); // pathological round — call it a draw
    }

    const w = matchWinnerIndex(state);
    tally[specs.indexOf(seatSpec[w])].wins += 1;
    for (let i = 0; i < n; i++) tally[specs.indexOf(seatSpec[i])].score += state.players[i].score;
  }

  const gamesPerEntry = args.games; // every entry plays every game (one seat each)
  console.log(`\n${args.games} matches, ${n} seats (rotated):`);
  for (let i = 0; i < n; i++) {
    const t = tally[i];
    const pct = ((t.wins / args.games) * 100).toFixed(1);
    const avg = (t.score / gamesPerEntry).toFixed(1);
    console.log(`  ${specs[i].label}: ${t.wins} wins (${pct}%), avg score ${avg}${t.planFailures ? `, plan failures: ${t.planFailures}` : ""}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

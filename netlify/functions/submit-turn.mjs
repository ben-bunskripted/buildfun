// Commit a state change. Three flavors:
//   1. Final turn commit by the current player — body: `state, lastTurn,
//      actionsDelta?`. Advances current_seat from `state.currentPlayerIndex`,
//      bumps seq, accumulates actions into last_turn (see below).
//   2. Intermediate commit by the current player — body: `state, actionsDelta,
//      intermediate: true`. Bumps seq + persists the mid-turn state so
//      spectators can render it, BUT keeps current_seat where it is. The
//      action delta is appended to the row's last_turn.actions; if last_turn
//      was a different seat (or empty) it's reset to start a new turn log.
//      This is what powers "see plays as the actor makes them" and also makes
//      mid-turn refresh recoverable — when the actor reloads they get the
//      partial action list back from the server.
//   3. Host control writes — round advance, match finish. Same as before:
//      lastTurn is null, no accumulator behavior.
//
// Optimistic concurrency on `seq`: a stale expectedSeq returns 409 plus the
// current authoritative state so the caller can reconcile.

import { db, getUser, json, parseBody } from "./_lib.mjs";

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });

  const { roomId, expectedSeq, state, lastTurn, actionsDelta, finished, intermediate } = parseBody(event);
  const code = (roomId || "").toString().trim().toUpperCase();
  if (!code) return json(400, { error: "room code required" });
  if (!state || typeof state !== "object") return json(400, { error: "missing state" });

  const sql = db();
  try {
    const rooms = await sql`SELECT host_uid FROM rooms WHERE id = ${code}`;
    if (rooms.length === 0) return json(404, { error: "room not found" });
    const isHost = rooms[0].host_uid === user.uid;

    const mySeat = await sql`SELECT seat_index FROM room_seats WHERE room_id = ${code} AND uid = ${user.uid}`;
    if (mySeat.length === 0) return json(403, { error: "not in this room" });
    const seat = mySeat[0].seat_index;

    const games = await sql`SELECT seq, current_seat, status, state, last_turn FROM games WHERE room_id = ${code}`;
    if (games.length === 0) return json(404, { error: "game not found" });
    const g = games[0];
    const seq = Number(g.seq);

    // Authority: current player commits their turn; host commits control writes.
    // Intermediate commits can only come from the current player (no host
    // bypass — they're not in the action stream).
    if (intermediate) {
      if (seat !== g.current_seat) return json(403, { error: "not your turn" });
    } else {
      if (seat !== g.current_seat && !isHost) {
        return json(403, { error: "not your turn" });
      }
    }
    if (Number(expectedSeq) !== seq) {
      return json(409, { error: "stale", seq, state: g.state, status: g.status });
    }

    // Build the new last_turn. If the caller passed a full `lastTurn` (legacy
    // final-commit path), use it verbatim. Otherwise accumulate `actionsDelta`
    // into whatever's on the row, resetting if the seat changed.
    let nextLastTurn = null;
    if (lastTurn && typeof lastTurn === "object") {
      nextLastTurn = lastTurn;
    } else if (Array.isArray(actionsDelta)) {
      const existing = g.last_turn || null;
      const sameTurn = existing && existing.seat === seat && Array.isArray(existing.actions);
      const baseActions = sameTurn ? existing.actions : [];
      nextLastTurn = { seat, actions: baseActions.concat(actionsDelta), at: Date.now() };
    } else if (intermediate) {
      // No delta and no lastTurn — just a state refresh. Preserve existing.
      nextLastTurn = g.last_turn || null;
    }

    // Intermediate commits don't advance the seat (actor still mid-turn).
    const nextSeat = intermediate
      ? g.current_seat
      : (Number.isInteger(state.currentPlayerIndex) ? state.currentPlayerIndex : g.current_seat);
    const nextStatus = finished ? "finished" : "playing";
    const nextSeq = seq + 1;
    await sql`UPDATE games SET seq = ${nextSeq}, current_seat = ${nextSeat}, status = ${nextStatus},
      state = ${JSON.stringify(state)}, last_turn = ${nextLastTurn ? JSON.stringify(nextLastTurn) : null}, updated_at = now()
      WHERE room_id = ${code}`;
    if (finished) await sql`UPDATE rooms SET status = 'finished', updated_at = now() WHERE id = ${code}`;

    return json(200, { ok: true, seq: nextSeq, currentSeat: nextSeat, status: nextStatus });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

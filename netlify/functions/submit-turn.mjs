// Commit a state change. Two writers are allowed (trust model, minimal guard):
//   - the player whose turn it is (a normal turn), or
//   - the host (round advancement / match end).
// Uses optimistic concurrency on `seq`: a stale expectedSeq returns 409 plus the
// current authoritative state so the caller can reconcile.

import { db, getUser, json, parseBody } from "./_lib.mjs";

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });

  const { roomId, expectedSeq, state, lastTurn, finished } = parseBody(event);
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

    const games = await sql`SELECT seq, current_seat, status, state FROM games WHERE room_id = ${code}`;
    if (games.length === 0) return json(404, { error: "game not found" });
    const g = games[0];
    const seq = Number(g.seq);

    // Authority: current player commits their turn; host commits control writes.
    if (seat !== g.current_seat && !isHost) {
      return json(403, { error: "not your turn" });
    }
    if (Number(expectedSeq) !== seq) {
      return json(409, { error: "stale", seq, state: g.state, status: g.status });
    }

    const nextSeat = Number.isInteger(state.currentPlayerIndex) ? state.currentPlayerIndex : g.current_seat;
    const nextStatus = finished ? "finished" : "playing";
    const nextSeq = seq + 1;
    await sql`UPDATE games SET seq = ${nextSeq}, current_seat = ${nextSeat}, status = ${nextStatus},
      state = ${JSON.stringify(state)}, last_turn = ${lastTurn ? JSON.stringify(lastTurn) : null}, updated_at = now()
      WHERE room_id = ${code}`;
    if (finished) await sql`UPDATE rooms SET status = 'finished', updated_at = now() WHERE id = ${code}`;

    return json(200, { ok: true, seq: nextSeq, currentSeat: nextSeat, status: nextStatus });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

// Host-only control writes. After the v1 client-authoritative cutover this
// endpoint exists ONLY for round advancement and match end — every actual
// game action goes through apply-action.mjs which is server-authoritative.
//
// Body: { roomId, expectedSeq, action: "advanceRound" | "finishMatch" }
//
// Both actions are host-only and operate on the canonical server state.
// advanceRound: moves the dealer forward and deals the next round.
// finishMatch: marks the room finished (used after match-end animations).

import { db, getUser, json, parseBody, checkBodySize, rateLimit } from "./_lib.mjs";
import { advanceToNextRound, isMatchOver, serialize, redactStateForSeat } from "./_engine.mjs";

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
  const tooBig = checkBodySize(event, 8 * 1024);
  if (tooBig) return tooBig;
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });

  const { roomId, expectedSeq, action } = parseBody(event);
  const code = (roomId || "").toString().trim().toUpperCase();
  if (!code) return json(400, { error: "room code required" });
  if (action !== "advanceRound" && action !== "finishMatch") {
    return json(400, { error: "invalid action — apply-action.mjs handles game moves now" });
  }

  const sql = db();
  const limited = await rateLimit(sql, user, "submit-turn");
  if (limited) return limited;
  try {
    const rooms = await sql`SELECT host_uid FROM rooms WHERE id = ${code}`;
    if (rooms.length === 0) return json(404, { error: "room not found" });
    if (rooms[0].host_uid !== user.uid) return json(403, { error: "host only" });

    const mySeatRow = await sql`SELECT seat_index FROM room_seats WHERE room_id = ${code} AND uid = ${user.uid}`;
    if (mySeatRow.length === 0) return json(403, { error: "not in this room" });
    const mySeat = mySeatRow[0].seat_index;

    const games = await sql`SELECT seq, current_seat, status, state FROM games WHERE room_id = ${code}`;
    if (games.length === 0) return json(404, { error: "game not found" });
    const g = games[0];
    const seq = Number(g.seq);
    if (Number(expectedSeq) !== seq) {
      const redacted = g.state ? redactStateForSeat(g.state, mySeat) : null;
      return json(409, { error: "stale", seq, state: redacted, status: g.status, currentSeat: g.current_seat });
    }
    if (!g.state) return json(500, { error: "missing game state" });

    if (action === "advanceRound") {
      if (g.state.phase !== "roundOver") return json(409, { error: "round not over" });
      if (isMatchOver(g.state)) return json(409, { error: "match is over — call finishMatch" });
      advanceToNextRound(g.state);
      const nextSeq = seq + 1;
      const nextSeat = g.state.currentPlayerIndex;
      // Seq-guarded UPDATE: see apply-action.mjs for rationale.
      const upd = await sql`UPDATE games SET seq = ${nextSeq}, current_seat = ${nextSeat}, status = 'playing',
        state = ${JSON.stringify(serialize(g.state))}, last_turn = NULL, updated_at = now()
        WHERE room_id = ${code} AND seq = ${seq}
        RETURNING seq`;
      if (!Array.isArray(upd) || upd.length === 0) {
        const fresh = await sql`SELECT seq, current_seat, status, state FROM games WHERE room_id = ${code}`;
        const f = fresh[0] || { seq, current_seat: nextSeat, status: "playing", state: null };
        const redacted = f.state ? redactStateForSeat(f.state, mySeat) : null;
        return json(409, { error: "stale", seq: Number(f.seq), state: redacted, status: f.status, currentSeat: f.current_seat });
      }
      return json(200, { ok: true, seq: nextSeq, currentSeat: nextSeat, status: "playing" });
    }

    // finishMatch
    if (!isMatchOver(g.state)) return json(409, { error: "match not over" });
    const nextSeq = seq + 1;
    const upd = await sql`UPDATE games SET seq = ${nextSeq}, status = 'finished', last_turn = NULL, updated_at = now()
      WHERE room_id = ${code} AND seq = ${seq}
      RETURNING seq`;
    if (!Array.isArray(upd) || upd.length === 0) {
      const fresh = await sql`SELECT seq, current_seat, status, state FROM games WHERE room_id = ${code}`;
      const f = fresh[0] || { seq, current_seat: g.current_seat, status: "finished", state: null };
      const redacted = f.state ? redactStateForSeat(f.state, mySeat) : null;
      return json(409, { error: "stale", seq: Number(f.seq), state: redacted, status: f.status, currentSeat: f.current_seat });
    }
    await sql`UPDATE rooms SET status = 'finished', updated_at = now() WHERE id = ${code}`;
    return json(200, { ok: true, seq: nextSeq, currentSeat: g.current_seat, status: "finished" });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

// Host starts the match. The host client builds the initial deal (createMatch +
// startNextRound, seated in room-seat order) and submits the serialized state.
// Trust model: the server stores what the host sends and flips the room to play.

import { db, getUser, json, parseBody } from "./_lib.mjs";

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });

  const { roomId, state } = parseBody(event);
  const code = (roomId || "").toString().trim().toUpperCase();
  if (!code) return json(400, { error: "room code required" });
  if (!state || typeof state !== "object") return json(400, { error: "missing state" });

  const sql = db();
  try {
    const rooms = await sql`SELECT host_uid, status, max_players FROM rooms WHERE id = ${code}`;
    if (rooms.length === 0) return json(404, { error: "room not found" });
    if (rooms[0].host_uid !== user.uid) return json(403, { error: "only the host can start" });
    if (rooms[0].status !== "lobby") return json(409, { error: "already started" });

    const seats = await sql`SELECT seat_index FROM room_seats WHERE room_id = ${code}`;
    const max = Number(rooms[0].max_players || 4);
    if (seats.length < 2) return json(400, { error: "need at least 2 players" });
    if (seats.length < max) {
      return json(409, { error: `Waiting for ${max - seats.length} more player${max - seats.length === 1 ? "" : "s"} before starting.` });
    }

    const currentSeat = Number.isInteger(state.currentPlayerIndex) ? state.currentPlayerIndex : 0;
    await sql`UPDATE games SET seq = 1, current_seat = ${currentSeat}, status = 'playing',
      state = ${JSON.stringify(state)}, last_turn = NULL, updated_at = now()
      WHERE room_id = ${code}`;
    await sql`UPDATE rooms SET status = 'playing', updated_at = now() WHERE id = ${code}`;

    return json(200, { ok: true, seq: 1, currentSeat, status: "playing" });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

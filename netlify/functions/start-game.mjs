// Host starts the match. Server-authoritative: the deal happens here. The host
// sends only `{roomId}`. The server creates the match from the current
// room_seats (names + seat order), shuffles, deals round 1, and persists the
// canonical state. Clients learn the dealt state via their next get-room poll
// (which redacts everyone else's hands).

import { db, getUser, json, parseBody } from "./_lib.mjs";
import { createMatch, startNextRound, serialize } from "./_engine.mjs";

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });

  const { roomId } = parseBody(event);
  const code = (roomId || "").toString().trim().toUpperCase();
  if (!code) return json(400, { error: "room code required" });

  const sql = db();
  try {
    const rooms = await sql`SELECT host_uid, status, max_players FROM rooms WHERE id = ${code}`;
    if (rooms.length === 0) return json(404, { error: "room not found" });
    if (rooms[0].host_uid !== user.uid) return json(403, { error: "only the host can start" });
    if (rooms[0].status !== "lobby") return json(409, { error: "already started" });

    const seats = await sql`SELECT seat_index, display_name FROM room_seats WHERE room_id = ${code} ORDER BY seat_index`;
    const max = Number(rooms[0].max_players || 4);
    if (seats.length < 2) return json(400, { error: "need at least 2 players" });
    if (seats.length < max) {
      return json(409, { error: `Waiting for ${max - seats.length} more player${max - seats.length === 1 ? "" : "s"} before starting.` });
    }

    // Seat order is the source of truth. The local engine uses each player's
    // index as their seat for the match; this matches because we order by
    // seat_index and use that array directly.
    const names = seats.map(s => s.display_name);
    // Dealer: random seat. RNG is server-side so the host can't pre-pick.
    const dealerIndex = Math.floor(seats.length * (() => {
      const buf = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buf);
      return buf[0] / 0xffffffff;
    })());
    const state = createMatch(names, dealerIndex, { mode: "online" });
    startNextRound(state);

    const currentSeat = state.currentPlayerIndex;
    await sql`UPDATE games SET seq = 1, current_seat = ${currentSeat}, status = 'playing',
      state = ${JSON.stringify(serialize(state))}, last_turn = NULL, updated_at = now()
      WHERE room_id = ${code}`;
    await sql`UPDATE rooms SET status = 'playing', updated_at = now() WHERE id = ${code}`;

    // Don't send the state in the response — the host gets it on their next
    // poll (with the host's hand visible and everyone else's redacted), same
    // as every other player. Keeps the redaction logic in one place.
    return json(200, { ok: true, seq: 1, currentSeat, status: "playing" });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

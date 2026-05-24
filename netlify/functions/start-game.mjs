// Host starts the match. Server-authoritative: the deal happens here. The host
// sends only `{roomId}`. The server creates the match from the current
// room_seats (names + seat order), shuffles, deals round 1, and persists the
// canonical state. Clients learn the dealt state via their next get-room poll
// (which redacts everyone else's hands).

import { db, getUser, json, parseBody, checkBodySize, rateLimit } from "./_lib.mjs";
import { createMatch, startNextRound, serialize } from "./_engine.mjs";
import { randomInt } from "../../projects/benny-card-game/js/rng.js";

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
  const tooBig = checkBodySize(event, 4 * 1024);
  if (tooBig) return tooBig;
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });

  const { roomId } = parseBody(event);
  const code = (roomId || "").toString().trim().toUpperCase();
  if (!code) return json(400, { error: "room code required" });

  const sql = db();
  const limited = await rateLimit(sql, user, "start-game");
  if (limited) return limited;
  try {
    const rooms = await sql`SELECT host_uid, status, max_players FROM rooms WHERE id = ${code}`;
    if (rooms.length === 0) return json(404, { error: "room not found" });
    if (rooms[0].host_uid !== user.uid) return json(403, { error: "only the host can start" });
    if (rooms[0].status !== "lobby") return json(409, { error: "already started" });

    const max = Number(rooms[0].max_players || 4);

    // Flip the room to "playing" FIRST, guarded on it still being a lobby.
    // Once this lands, `join-room`'s `status === 'lobby'` check will reject
    // any racing joiner — without that we could read seats here, deal those
    // names, and have a late join INSERT a seat that has no corresponding
    // state.players[i] (their `mySeat` would index past the array and the
    // redactor would hide every hand from them).
    const flipped = await sql`UPDATE rooms SET status = 'playing', updated_at = now()
      WHERE id = ${code} AND status = 'lobby' RETURNING id`;
    if (!Array.isArray(flipped) || flipped.length === 0) {
      return json(409, { error: "already started" });
    }

    const seats = await sql`SELECT seat_index, display_name FROM room_seats WHERE room_id = ${code} ORDER BY seat_index`;
    if (seats.length < 2 || seats.length < max) {
      // Roster isn't full (or shrank between the lobby render and this
      // call). Roll the lobby flip back so the host can try again.
      await sql`UPDATE rooms SET status = 'lobby', updated_at = now() WHERE id = ${code}`;
      if (seats.length < 2) return json(400, { error: "need at least 2 players" });
      const missing = max - seats.length;
      return json(409, { error: `Waiting for ${missing} more player${missing === 1 ? "" : "s"} before starting.` });
    }

    // Seat order is the source of truth. The local engine uses each player's
    // index as their seat for the match; this matches because we order by
    // seat_index and use that array directly.
    const names = seats.map(s => s.display_name);
    // Dealer: random seat. RNG is server-side so the host can't pre-pick.
    // Use the unbiased crypto-backed randomInt from the shared engine — the
    // earlier float-division approach could return seats.length on the 1-in-
    // 2^32 chance buf[0] === 0xffffffff (Math.floor(N * 1.0) === N).
    const dealerIndex = randomInt(seats.length);
    const state = createMatch(names, dealerIndex, { mode: "online" });
    startNextRound(state);

    const currentSeat = state.currentPlayerIndex;
    await sql`UPDATE games SET seq = 1, current_seat = ${currentSeat}, status = 'playing',
      state = ${JSON.stringify(serialize(state))}, last_turn = NULL, updated_at = now()
      WHERE room_id = ${code}`;

    // Don't send the state in the response — the host gets it on their next
    // poll (with the host's hand visible and everyone else's redacted), same
    // as every other player. Keeps the redaction logic in one place.
    return json(200, { ok: true, seq: 1, currentSeat, status: "playing" });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

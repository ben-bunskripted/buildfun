// Poll endpoint. Always returns room meta + seats + current seq/status so the
// client can detect lobby->playing->finished transitions. Includes the full
// game state + last_turn only when something newer than `since` exists (saves
// bandwidth on idle polls).
//
// When `?wait=1` is passed AND the games row's seq is not newer than `since`,
// the request is held for up to ~9s, re-checking the games row every 600ms
// until something newer arrives. This long-poll mode cuts perceived latency
// during gameplay from ~750ms (avg half a poll interval) to ~50ms. It's only
// safe to use once a game is in progress — lobby roster changes don't bump
// seq, so callers must still short-poll while status is "lobby".
//
// Trust model: state is sent unredacted.

import { db, getUser, json } from "./_lib.mjs";

const LONG_POLL_MS = 9000;
const LONG_POLL_STEP_MS = 600;

export const handler = async (event, context) => {
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });
  const params = event.queryStringParameters || {};
  const code = (params.roomId || "").toString().trim().toUpperCase();
  const since = Number(params.since) || 0;
  const wait = params.wait === "1" || params.wait === "true";
  if (!code) return json(400, { error: "room code required" });

  const sql = db();
  try {
    const rooms = await sql`SELECT id, name, host_uid, status, max_players FROM rooms WHERE id = ${code}`;
    if (rooms.length === 0) return json(404, { error: "room not found" });
    const room = rooms[0];
    const seatRows = await sql`SELECT seat_index, uid, display_name, connected
      FROM room_seats WHERE room_id = ${code} ORDER BY seat_index`;
    const players = seatRows.map(s => ({ seat: s.seat_index, uid: s.uid, name: s.display_name, connected: s.connected }));
    const mySeatRow = seatRows.find(s => s.uid === user.uid);

    let g;
    {
      const games = await sql`SELECT seq, current_seat, status, state, last_turn FROM games WHERE room_id = ${code}`;
      g = games[0] || { seq: 0, current_seat: 0, status: room.status, state: null, last_turn: null };
    }

    // Long-poll: if the caller already has the latest seq, hold the request
    // briefly and re-check until something new lands (or we hit the cap).
    if (wait && Number(g.seq) <= since) {
      const deadline = Date.now() + LONG_POLL_MS;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, LONG_POLL_STEP_MS));
        const games2 = await sql`SELECT seq, current_seat, status, state, last_turn FROM games WHERE room_id = ${code}`;
        if (games2.length > 0 && Number(games2[0].seq) > since) {
          g = games2[0];
          break;
        }
      }
    }

    const seq = Number(g.seq);
    const out = {
      roomId: code,
      name: room.name,
      status: g.status || room.status,
      maxPlayers: room.max_players,
      isHost: room.host_uid === user.uid,
      seat: mySeatRow ? mySeatRow.seat_index : null,
      players,
      seq,
      currentSeat: g.current_seat,
    };
    if (seq > since) {
      out.state = g.state || null;
      out.lastTurn = g.last_turn || null;
    }
    return json(200, out);
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

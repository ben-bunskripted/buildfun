// Poll endpoint. Always returns room meta + seats + current seq/status so the
// client can detect lobby->playing->finished transitions. Includes the full
// game state + last_turn only when something newer than `since` exists (saves
// bandwidth on idle polls). Trust model: state is sent unredacted.

import { db, getUser, json } from "./_lib.mjs";

export const handler = async (event, context) => {
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });
  const params = event.queryStringParameters || {};
  const code = (params.roomId || "").toString().trim().toUpperCase();
  const since = Number(params.since) || 0;
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

    const games = await sql`SELECT seq, current_seat, status, state, last_turn FROM games WHERE room_id = ${code}`;
    const g = games[0] || { seq: 0, current_seat: 0, status: room.status, state: null, last_turn: null };
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

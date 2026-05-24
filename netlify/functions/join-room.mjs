// Join a room by code. Idempotent: if the caller already holds a seat, their
// existing seat is returned. Validates password (private), capacity, and that
// the room is still in the lobby.

import {
  db, getUser, json, parseBody, verifyPassword,
  countActiveRoomsForUser, MAX_ACTIVE_ROOMS_PER_USER,
} from "./_lib.mjs";
import { redactStateForSeat } from "./_engine.mjs";

async function roomSnapshot(sql, roomId) {
  const seats = await sql`SELECT seat_index, uid, display_name, connected
    FROM room_seats WHERE room_id = ${roomId} ORDER BY seat_index`;
  return seats.map(s => ({ seat: s.seat_index, uid: s.uid, name: s.display_name, connected: s.connected }));
}

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });

  const { roomId, password, displayName } = parseBody(event);
  const code = (roomId || "").toString().trim().toUpperCase();
  if (!code) return json(400, { error: "room code required" });
  const seatName = (displayName || user.name || "Player").toString().trim().slice(0, 40) || "Player";

  const sql = db();
  try {
    const rooms = await sql`SELECT id, name, host_uid, visibility, password_hash, status, max_players
      FROM rooms WHERE id = ${code}`;
    if (rooms.length === 0) return json(404, { error: "no game with that code" });
    const room = rooms[0];

    // Already seated? Return existing seat (rejoin / refresh). For an
    // in-progress game we also return the live state + last_turn so the client
    // can adopt immediately — without this, the client's first poll asks
    // `since = currentSeq` and the server long-polls up to ~9s waiting for a
    // newer seq, leaving the rejoiner stuck on a "Joining game…" splash.
    const mine = await sql`SELECT seat_index FROM room_seats WHERE room_id = ${code} AND uid = ${user.uid}`;
    if (mine.length > 0) {
      await sql`UPDATE room_seats SET connected = true WHERE room_id = ${code} AND uid = ${user.uid}`;
      const game = await sql`SELECT seq, status, state, last_turn, current_seat FROM games WHERE room_id = ${code}`;
      const g = game[0];
      const inPlay = g && (g.status === "playing" || g.status === "finished");
      const seat = mine[0].seat_index;
      const redacted = inPlay && g.state ? redactStateForSeat(g.state, seat) : null;
      return json(200, {
        roomId: code, name: room.name, status: room.status, maxPlayers: room.max_players,
        seat, isHost: room.host_uid === user.uid,
        seq: g ? Number(g.seq) : 0,
        currentSeat: g ? g.current_seat : 0,
        state: redacted,
        lastTurn: inPlay ? (g.last_turn || null) : null,
        players: await roomSnapshot(sql, code),
      });
    }

    if (room.status !== "lobby") return json(409, { error: "this game has already started" });
    if (room.visibility === "private") {
      const ok = await verifyPassword(String(password || ""), room.password_hash);
      if (!ok) return json(403, { error: "wrong password" });
    }

    // Per-user table cap (only checked for NEW seats — rejoins above bypass).
    const activeCount = await countActiveRoomsForUser(sql, user.uid);
    if (activeCount >= MAX_ACTIVE_ROOMS_PER_USER) {
      return json(409, {
        error: `You already have ${activeCount} open tables — archive one before joining a new game.`,
        code: "table-cap",
        cap: MAX_ACTIVE_ROOMS_PER_USER,
      });
    }

    // Allocate the lowest free seat index, retrying on a concurrent grab.
    for (let attempt = 0; attempt < 5; attempt++) {
      const seats = await sql`SELECT seat_index FROM room_seats WHERE room_id = ${code} ORDER BY seat_index`;
      if (seats.length >= room.max_players) return json(409, { error: "this game is full" });
      const taken = new Set(seats.map(s => s.seat_index));
      let seat = 0;
      while (taken.has(seat)) seat++;
      try {
        await sql`INSERT INTO room_seats (room_id, seat_index, uid, display_name)
          VALUES (${code}, ${seat}, ${user.uid}, ${seatName})`;
        await sql`UPDATE rooms SET updated_at = now() WHERE id = ${code}`;
        return json(200, {
          roomId: code, name: room.name, status: room.status, maxPlayers: room.max_players,
          seat, isHost: room.host_uid === user.uid, seq: 0,
          players: await roomSnapshot(sql, code),
        });
      } catch (_clash) {
        // Seat index was taken between SELECT and INSERT — retry.
      }
    }
    return json(409, { error: "could not grab a seat, try again" });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

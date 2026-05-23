// Leave (or archive) a room.
//
// Two semantics behind one endpoint:
//
//   archive: false (default) — "Leave table" in the active lobby. Removes the
//     caller's seat. If the host leaves while still in the lobby, the room
//     is deleted (cascades). Mid-game we only mark the seat disconnected so
//     remaining players can keep playing on a consistent state.
//
//   archive: true — "I'm done with this game forever". Removes the caller's
//     seat AND decrements rooms.max_players by 1 (so the table can still
//     start once the smaller roster is full). The room auto-deletes when:
//       * the caller is the host and the game has started, OR
//       * max_players drops below 2 (can't run a 2-player game anymore), OR
//       * the only remaining seat just vacated.

import { db, getUser, json, parseBody } from "./_lib.mjs";

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });
  const { roomId, archive } = parseBody(event);
  const code = (roomId || "").toString().trim().toUpperCase();
  if (!code) return json(400, { error: "room code required" });
  const isArchive = !!archive;

  const sql = db();
  try {
    const rooms = await sql`SELECT host_uid, status, max_players FROM rooms WHERE id = ${code}`;
    if (rooms.length === 0) return json(200, { ok: true, roomClosed: true });
    const room = rooms[0];
    const isHost = room.host_uid === user.uid;

    if (!isArchive) {
      // Plain leave (lobby reshuffle / in-game disconnect).
      if (room.status === "lobby") {
        if (isHost) {
          await sql`DELETE FROM rooms WHERE id = ${code}`; // cascades to seats + game
          return json(200, { ok: true, roomClosed: true });
        }
        await sql`DELETE FROM room_seats WHERE room_id = ${code} AND uid = ${user.uid}`;
        await sql`UPDATE rooms SET updated_at = now() WHERE id = ${code}`;
        return json(200, { ok: true });
      }
      await sql`UPDATE room_seats SET connected = false WHERE room_id = ${code} AND uid = ${user.uid}`;
      return json(200, { ok: true });
    }

    // Archive: caller is permanently leaving this table.
    // Host archiving an in-progress game is equivalent to ending it — the
    // table can't continue without its host. Same outcome for any archive
    // that drops the room below the minimum viable size.
    if (isHost && room.status !== "lobby") {
      await sql`DELETE FROM rooms WHERE id = ${code}`;
      return json(200, { ok: true, roomClosed: true });
    }

    await sql`DELETE FROM room_seats WHERE room_id = ${code} AND uid = ${user.uid}`;
    const newMax = Math.max(0, Number(room.max_players) - 1);
    const remaining = await sql`SELECT COUNT(*)::int AS n FROM room_seats WHERE room_id = ${code}`;
    const seatsLeft = remaining[0] ? Number(remaining[0].n) : 0;

    if (newMax < 2 || seatsLeft === 0) {
      await sql`DELETE FROM rooms WHERE id = ${code}`;
      return json(200, { ok: true, roomClosed: true });
    }

    await sql`UPDATE rooms SET max_players = ${newMax}, updated_at = now() WHERE id = ${code}`;
    return json(200, { ok: true, maxPlayers: newMax });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

// Leave a room. In the lobby, the seat is removed (and the host leaving deletes
// the room entirely). Mid-game we just mark the seat disconnected so the rest of
// the table can keep their state consistent (minimal v1 handling).

import { db, getUser, json, parseBody } from "./_lib.mjs";

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });
  const { roomId } = parseBody(event);
  const code = (roomId || "").toString().trim().toUpperCase();
  if (!code) return json(400, { error: "room code required" });

  const sql = db();
  try {
    const rooms = await sql`SELECT host_uid, status FROM rooms WHERE id = ${code}`;
    if (rooms.length === 0) return json(200, { ok: true });
    const room = rooms[0];

    if (room.status === "lobby") {
      if (room.host_uid === user.uid) {
        await sql`DELETE FROM rooms WHERE id = ${code}`; // cascades to seats + game
        return json(200, { ok: true, roomClosed: true });
      }
      await sql`DELETE FROM room_seats WHERE room_id = ${code} AND uid = ${user.uid}`;
      await sql`UPDATE rooms SET updated_at = now() WHERE id = ${code}`;
      return json(200, { ok: true });
    }

    await sql`UPDATE room_seats SET connected = false WHERE room_id = ${code} AND uid = ${user.uid}`;
    return json(200, { ok: true });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

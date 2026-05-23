// Host-only: end the game for everyone. Hard-deletes the room (cascade kills
// room_seats + games), so the room vanishes from every participant's
// my-rooms list on their next refresh. This is the "the host quit the table"
// path — for an individual user walking away, see leave-room with archive.

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
    const rooms = await sql`SELECT host_uid FROM rooms WHERE id = ${code}`;
    if (rooms.length === 0) return json(200, { ok: true, roomClosed: true });
    if (rooms[0].host_uid !== user.uid) return json(403, { error: "only the host can end the game" });

    await sql`DELETE FROM rooms WHERE id = ${code}`; // cascades to seats + games
    return json(200, { ok: true, roomClosed: true });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

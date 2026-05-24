// List the signed-in user's active tables — rooms where they hold a seat and
// the game hasn't finished. Used by the Online tab's "Resume" affordance so a
// player who closed the tab mid-game can find their way back in.
//
// A separate endpoint (rather than reusing list-rooms) because list-rooms is
// the public-table browser and this is per-user; combining them would either
// leak private rooms or require a flag.

import { db, getUser, json, rateLimit } from "./_lib.mjs";

export const handler = async (event, context) => {
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });

  const sql = db();
  const limited = await rateLimit(sql, user, "my-rooms");
  if (limited) return limited;
  try {
    const rows = await sql`
      SELECT r.id, r.name, r.status, r.max_players, r.host_uid, s.seat_index,
        g.current_seat,
        (SELECT COUNT(*)::int FROM room_seats s2 WHERE s2.room_id = r.id) AS players
      FROM rooms r
      JOIN room_seats s ON s.room_id = r.id AND s.uid = ${user.uid}
      LEFT JOIN games g ON g.room_id = r.id
      WHERE r.status != 'finished'
      ORDER BY r.updated_at DESC`;
    const rooms = rows.map(r => ({
      roomId: r.id,
      name: r.name,
      status: r.status,
      mySeat: r.seat_index,
      currentSeat: r.current_seat,
      isMyTurn: r.status === "playing" && r.current_seat === r.seat_index,
      isHost: r.host_uid === user.uid,
      players: r.players,
      maxPlayers: r.max_players,
    }));
    return json(200, { rooms });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

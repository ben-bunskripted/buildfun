// List joinable public rooms still in the lobby.

import { db, getUser, json, rateLimit } from "./_lib.mjs";

export const handler = async (event, context) => {
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });
  const sql = db();
  const limited = await rateLimit(sql, user, "list-rooms");
  if (limited) return limited;
  try {
    const rows = await sql`
      SELECT r.id, r.name, r.max_players,
             (SELECT count(*) FROM room_seats s WHERE s.room_id = r.id) AS players
      FROM rooms r
      WHERE r.visibility = 'public' AND r.status = 'lobby'
      ORDER BY r.updated_at DESC
      LIMIT 30`;
    const rooms = rows
      .map(r => ({ roomId: r.id, name: r.name, players: Number(r.players), maxPlayers: r.max_players }))
      .filter(r => r.players < r.maxPlayers);
    return json(200, { rooms });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

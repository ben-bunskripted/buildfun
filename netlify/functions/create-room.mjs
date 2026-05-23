// Create a room. The caller becomes the host at seat 0. The game starts in
// "lobby" status with no dealt state yet (see start-game).

import { db, getUser, json, parseBody, hashPassword, makeRoomCode } from "./_lib.mjs";

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });

  const { name, visibility, password, displayName, maxPlayers } = parseBody(event);
  const roomName = (name || "").toString().trim().slice(0, 40) || `${user.name}'s game`;
  const vis = visibility === "private" ? "private" : "public";
  const max = Math.min(4, Math.max(2, Number(maxPlayers) || 4));
  const seatName = (displayName || user.name || "Player").toString().trim().slice(0, 40) || "Player";
  if (vis === "private" && !password) return json(400, { error: "private rooms need a password" });
  const passwordHash = vis === "private" ? await hashPassword(String(password)) : null;

  const sql = db();
  try {
    // Find a free code (retry a few times on the astronomically rare clash).
    let code = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = makeRoomCode(5);
      const existing = await sql`SELECT 1 FROM rooms WHERE id = ${candidate}`;
      if (existing.length === 0) { code = candidate; break; }
    }
    if (!code) return json(503, { error: "could not allocate a room code, try again" });

    await sql`INSERT INTO rooms (id, name, host_uid, visibility, password_hash, status, max_players)
      VALUES (${code}, ${roomName}, ${user.uid}, ${vis}, ${passwordHash}, 'lobby', ${max})`;
    await sql`INSERT INTO room_seats (room_id, seat_index, uid, display_name)
      VALUES (${code}, 0, ${user.uid}, ${seatName})`;
    await sql`INSERT INTO games (room_id, seq, current_seat, status) VALUES (${code}, 0, 0, 'lobby')`;

    return json(200, {
      roomId: code,
      name: roomName,
      visibility: vis,
      maxPlayers: max,
      status: "lobby",
      seq: 0,
      seat: 0,
      isHost: true,
      players: [{ seat: 0, uid: user.uid, name: seatName, connected: true }],
    });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

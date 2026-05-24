// Create a room. The caller becomes the host at seat 0. The game starts in
// "lobby" status with no dealt state yet (see start-game).

import {
  db, getUser, json, parseBody, hashPassword, makeRoomCode,
  canonicalDisplayName, checkBodySize, rateLimit,
  countActiveRoomsForUser, MAX_ACTIVE_ROOMS_PER_USER,
} from "./_lib.mjs";

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
  const tooBig = checkBodySize(event, 8 * 1024);
  if (tooBig) return tooBig;
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });

  const { name, visibility, password, maxPlayers } = parseBody(event);
  const vis = visibility === "private" ? "private" : "public";
  const max = Math.min(4, Math.max(2, Number(maxPlayers) || 4));
  if (vis === "private" && !password) return json(400, { error: "private rooms need a password" });
  const passwordHash = vis === "private" ? await hashPassword(String(password)) : null;

  const sql = db();
  const limited = await rateLimit(sql, user, "create-room");
  if (limited) return limited;
  try {
    // Pinned display name — what the user stored via auth-sync, not whatever
    // they typed into the lobby form. Prevents seat-level impersonation.
    const seatName = await canonicalDisplayName(sql, user);
    const roomName = (name || "").toString().trim().slice(0, 40) || `${seatName}'s game`;
    // Per-user table cap. Returning 409 with a typed code lets the client
    // show "archive an old game" rather than a generic error toast.
    const activeCount = await countActiveRoomsForUser(sql, user.uid);
    if (activeCount >= MAX_ACTIVE_ROOMS_PER_USER) {
      return json(409, {
        error: `You already have ${activeCount} open tables — archive one before starting a new game.`,
        code: "table-cap",
        cap: MAX_ACTIVE_ROOMS_PER_USER,
      });
    }
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
      players: [{
        seat: 0, uid: user.uid, name: seatName, connected: true,
        online: true, lastSeenAt: new Date().toISOString(),
      }],
    });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

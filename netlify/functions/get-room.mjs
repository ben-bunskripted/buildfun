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
// Presence: every poll is also a heartbeat. The caller's seat last_seen_at is
// bumped to now() (after the long-poll wait, so the response carries the
// freshest roster), and each returned seat is annotated with an `online`
// boolean (last seen within ONLINE_THRESHOLD_MS) plus `lastSeenAt` ISO so the
// client can render "away 2m" labels.
//
// Server-authoritative trust model: `state` is redacted before send. The
// caller sees their own hand verbatim; every other player's hand and the
// deck are replaced with same-length opaque placeholders.

import { db, getUser, json, rateLimit } from "./_lib.mjs";
import { redactStateForSeat } from "./_engine.mjs";

const LONG_POLL_MS = 9000;
const LONG_POLL_STEP_MS = 600;
// Headroom: lobby polls every ~1.5s; in-game long-polls can hold ~9s. 20s
// covers a completed long-poll plus a generous network buffer before the
// next request lands.
const ONLINE_THRESHOLD_MS = 20_000;

export const handler = async (event, context) => {
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });
  const params = event.queryStringParameters || {};
  const code = (params.roomId || "").toString().trim().toUpperCase();
  const since = Number(params.since) || 0;
  const wait = params.wait === "1" || params.wait === "true";
  if (!code) return json(400, { error: "room code required" });

  const sql = db();
  const limited = await rateLimit(sql, user, "get-room");
  if (limited) return limited;
  try {
    const rooms = await sql`SELECT id, name, host_uid, status, max_players FROM rooms WHERE id = ${code}`;
    if (rooms.length === 0) return json(404, { error: "room not found" });
    const room = rooms[0];

    // Only seated players (or the host) can poll. The password gates
    // join-room — without this check, any signed-in user who guessed the
    // 5-char code could spectate a private game's redacted state via
    // `last_turn.actions`. Done before long-poll so non-members can't tie
    // up function time either. Host is allowed even seatless so they can
    // still observe a room they own.
    if (room.host_uid !== user.uid) {
      const seatCheck = await sql`SELECT 1 FROM room_seats WHERE room_id = ${code} AND uid = ${user.uid}`;
      if (seatCheck.length === 0) return json(403, { error: "not in this room" });
    }

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

    // Heartbeat the caller then read the roster, so the response carries the
    // freshest presence info (including the just-bumped self timestamp).
    await sql`UPDATE room_seats SET last_seen_at = now() WHERE room_id = ${code} AND uid = ${user.uid}`;
    const seatRows = await sql`SELECT seat_index, uid, display_name, connected, last_seen_at
      FROM room_seats WHERE room_id = ${code} ORDER BY seat_index`;
    const cutoff = Date.now() - ONLINE_THRESHOLD_MS;
    const players = seatRows.map(s => {
      const lastSeenMs = new Date(s.last_seen_at).getTime();
      return {
        seat: s.seat_index,
        uid: s.uid,
        name: s.display_name,
        connected: s.connected,
        online: lastSeenMs >= cutoff,
        lastSeenAt: s.last_seen_at,
      };
    });
    const mySeatRow = seatRows.find(s => s.uid === user.uid);
    const mySeat = mySeatRow ? mySeatRow.seat_index : null;

    const seq = Number(g.seq);
    const out = {
      roomId: code,
      name: room.name,
      status: g.status || room.status,
      maxPlayers: room.max_players,
      isHost: room.host_uid === user.uid,
      seat: mySeat,
      players,
      seq,
      currentSeat: g.current_seat,
    };
    if (seq > since) {
      // Redact state for the caller. Players with no seat (shouldn't happen
      // because join-room is required) get a fully-redacted view.
      out.state = g.state ? redactStateForSeat(g.state, mySeat == null ? -1 : mySeat) : null;
      out.lastTurn = g.last_turn || null;
    }
    return json(200, out);
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

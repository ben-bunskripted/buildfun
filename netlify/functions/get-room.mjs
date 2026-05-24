// Poll endpoint. Returns room meta + roster + (when changed) game state.
//
// Conditional fetch: clients send `If-None-Match: "<seq>-<updatedAtEpoch>"`.
// If both halves match the server's current values, we return 304 without
// doing the full state read, roster read, or presence bump. The composite is
// needed because lobby roster mutations (join/leave) bump `rooms.updated_at`
// without touching `games.seq` — using seq alone would mean a host wouldn't
// see new players join.
//
// Known limitation: `room_seats.last_seen_at` updates do NOT invalidate the
// ETag, so a player who AFKs and returns won't reappear as "online" on other
// screens until something else bumps the version (a join, leave, or game
// action). Acceptable trade for the cache savings; presence catches up the
// next time anything material happens.
//
// Full fetch: when state has moved on (or the client didn't send an ETag),
// a single CTE query loads room meta + game state + roster in one round
// trip — replacing the three sequential SELECTs the previous version did.
//
// Presence: every poll is a heartbeat for the caller's seat, but the
// `last_seen_at` write is throttled to once per PRESENCE_THROTTLE_SECONDS so
// a tight poll loop doesn't write per-request. Each returned seat is tagged
// with `online` (last seen within ONLINE_THRESHOLD_MS) plus the raw
// `lastSeenAt` so the client can render "away" badges.
//
// Server-authoritative trust model: `state` is redacted before send. The
// caller sees their own hand verbatim; every other player's hand and the
// deck are replaced with same-length opaque placeholders.

import { db, getUser, json, notModified, rateLimit } from "./_lib.mjs";
import { redactStateForSeat } from "./_engine.mjs";

// How long a seat can be silent before we render it as "away". Must be
// strictly greater than PRESENCE_THROTTLE_SECONDS plus one poll interval —
// otherwise an actively-polling player whose last_seen_at hasn't been
// re-written yet would flicker to "offline" between throttled writes.
const ONLINE_THRESHOLD_MS = 90_000;
// Presence write throttle: skip the last_seen_at UPDATE if it was already
// bumped within this many seconds. The active player polls many times within
// this window; only the first poll writes. Drops ~98% of presence writes on
// a 1.5s poll loop in-game.
const PRESENCE_THROTTLE_SECONDS = 60;

export const handler = async (event, context) => {
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });
  const params = event.queryStringParameters || {};
  const code = (params.roomId || "").toString().trim().toUpperCase();
  const since = Number(params.since) || 0;
  if (!code) return json(400, { error: "room code required" });

  const sql = db();
  const limited = await rateLimit(sql, user, "get-room");
  if (limited) return limited;
  try {
    // Cheap head query: existence + authorization + composite version. Done
    // before the full fetch so (a) we can 304-fast-path when nothing has
    // changed, and (b) we never leak room existence to non-members via a 304
    // vs 403. `updated_epoch` covers roster mutations (join/leave bump
    // rooms.updated_at); `seq` covers game state mutations.
    const head = await sql`
      SELECT
        (r.host_uid = ${user.uid} OR s.uid IS NOT NULL) AS authorized,
        COALESCE(g.seq, 0)::bigint AS seq,
        EXTRACT(EPOCH FROM r.updated_at)::bigint AS updated_epoch
      FROM rooms r
      LEFT JOIN room_seats s ON s.room_id = r.id AND s.uid = ${user.uid}
      LEFT JOIN games g ON g.room_id = r.id
      WHERE r.id = ${code}`;
    if (head.length === 0) return json(404, { error: "room not found" });
    if (!head[0].authorized) return json(403, { error: "not in this room" });
    const currentSeq = Number(head[0].seq);
    const updatedEpoch = Number(head[0].updated_epoch);
    const version = `${currentSeq}-${updatedEpoch}`;

    // Conditional GET: client's ETag is the last version it saw. Header keys
    // are lowercased by Netlify; fall back to the canonical case for local dev.
    const ifNoneMatch = (event.headers && (event.headers["if-none-match"] || event.headers["If-None-Match"])) || null;
    if (ifNoneMatch) {
      const clientVersion = ifNoneMatch.replace(/^W\//, "").replace(/"/g, "").trim();
      if (clientVersion === version) return notModified(version);
    }

    // Full fetch: room + game + roster in one round trip. Aggregating the
    // roster into json_agg inside the query avoids a separate SELECT.
    const rows = await sql`
      WITH room_info AS (
        SELECT id, name, host_uid, status, max_players FROM rooms WHERE id = ${code}
      ),
      game_info AS (
        SELECT seq, current_seat, status, state, last_turn FROM games WHERE room_id = ${code}
      ),
      roster AS (
        SELECT COALESCE(json_agg(json_build_object(
          'seat_index', seat_index,
          'uid', uid,
          'display_name', display_name,
          'connected', connected,
          'last_seen_at', last_seen_at
        ) ORDER BY seat_index), '[]'::json) AS seats
        FROM room_seats WHERE room_id = ${code}
      )
      SELECT
        (SELECT row_to_json(room_info) FROM room_info) AS room,
        (SELECT row_to_json(game_info) FROM game_info) AS game,
        (SELECT seats FROM roster) AS seats`;
    if (rows.length === 0 || !rows[0].room) return json(404, { error: "room not found" });
    const room = rows[0].room;
    const g = rows[0].game || { seq: 0, current_seat: 0, status: room.status, state: null, last_turn: null };
    const seatRows = rows[0].seats || [];

    // Throttled presence bump. Skipped if last_seen_at is fresh enough — at a
    // 1.5s poll cadence, only ~1 in 10 polls actually writes.
    await sql`UPDATE room_seats
      SET last_seen_at = now()
      WHERE room_id = ${code}
        AND uid = ${user.uid}
        AND last_seen_at < now() - (${PRESENCE_THROTTLE_SECONDS} || ' seconds')::interval`;

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
    return json(200, out, { ETag: `"${version}"` });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

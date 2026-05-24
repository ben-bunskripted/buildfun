// Server-authoritative single-action commit. The actor sends one action; the
// server validates that it's their turn, applies the action via the same
// engine the client uses, persists, and returns the redacted post-state.
//
// Body: { roomId, expectedSeq, action }
// Action shapes (see _engine.mjs:applyAction):
//   { type: "drawDeck" }
//   { type: "drawDiscard" }
//   { type: "play", arrangement }
//   { type: "add", setId, arrangement }
//   { type: "swap", setId, positionIndex, naturalCardId }
//   { type: "discard", cardId }
//
// Response: { ok, seq, currentSeat, status, state, lastTurn, drawnCard? }
// - state: redacted for the caller's seat (their own hand visible; everyone
//   else's hands + the deck replaced with opaque placeholders).
// - lastTurn: the action stream including this action (no hidden info — only
//   public-info versions of each action are appended; drawDeck never carries
//   the drawn card).
// - drawnCard: only set on drawDeck. Sent ONLY to the actor so they can
//   render their new card; never persisted in last_turn, never seen by
//   spectators.
//
// Stale seq → 409 with the authoritative current state attached so the caller
// can adopt + retry.

import { db, getUser, json, parseBody, checkBodySize, rateLimit } from "./_lib.mjs";
import {
  applyAction, redactStateForSeat, serialize,
  isNoWayOut, finalizeNoWayOut,
} from "./_engine.mjs";

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
  const tooBig = checkBodySize(event, 64 * 1024);
  if (tooBig) return tooBig;
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });

  const { roomId, expectedSeq, action } = parseBody(event);
  const code = (roomId || "").toString().trim().toUpperCase();
  if (!code) return json(400, { error: "room code required" });

  const sql = db();
  const limited = await rateLimit(sql, user, "apply-action");
  if (limited) return limited;
  try {
    const mySeatRow = await sql`SELECT seat_index FROM room_seats WHERE room_id = ${code} AND uid = ${user.uid}`;
    if (mySeatRow.length === 0) return json(403, { error: "not in this room" });
    const seat = mySeatRow[0].seat_index;

    const games = await sql`SELECT seq, current_seat, status, state, last_turn FROM games WHERE room_id = ${code}`;
    if (games.length === 0) return json(404, { error: "game not found" });
    const g = games[0];
    const seq = Number(g.seq);

    if (Number(expectedSeq) !== seq) {
      // Stale — send the caller the authoritative redacted state so they can
      // adopt without another round-trip.
      const redacted = g.state ? redactStateForSeat(g.state, seat) : null;
      return json(409, { error: "stale", seq, state: redacted, status: g.status, currentSeat: g.current_seat });
    }
    if (g.status !== "playing") return json(409, { error: "game not in progress" });
    if (seat !== g.current_seat) return json(403, { error: "not your turn" });
    if (!g.state) return json(500, { error: "missing game state" });

    // Mutates g.state in place — that's fine because we only persist what comes
    // out of this call. The redactor JSON-clones before sending.
    const result = applyAction(g.state, seat, action);
    if (!result.ok) return json(400, { error: result.reason || "invalid action" });

    // After a discard that didn't end the round, the engine has already
    // advanced to the next player (phase: "passing"). Check for a deadlock
    // (no legal play for anyone, table fully capped) and finalize as a draw
    // round if so. Has to happen server-side because clients can't see hands.
    let noWayOutTriggered = false;
    if (action.type === "discard" && !result.wonRound && isNoWayOut(g.state)) {
      finalizeNoWayOut(g.state);
      noWayOutTriggered = true;
    }

    // Append the (public-info-only) recorded action to last_turn.actions.
    const existing = g.last_turn || null;
    const sameTurn = existing && existing.seat === seat && Array.isArray(existing.actions);
    const baseActions = sameTurn ? existing.actions : [];
    const lastTurn = {
      seat,
      actions: baseActions.concat([{ ...result.recordedAction, at: Date.now() }]),
      at: Date.now(),
    };

    const nextSeq = seq + 1;
    // currentPlayerIndex is updated by the engine when the turn ends (discard
    // that doesn't win, or the engine itself shifting `phase: "passing"`).
    const nextSeat = g.state.currentPlayerIndex;
    const nextStatus = "playing";

    // Optimistic UPDATE: only succeed if seq hasn't moved since our read.
    // Without the seq guard two concurrent apply-actions could both pass the
    // pre-write seq check, then both UPDATE — last writer silently wins and
    // the other action is dropped while its caller is told it succeeded.
    // RETURNING gives us a portable rowsAffected signal across neon's driver
    // versions (no need to inspect a non-array `rowCount` property).
    const upd = await sql`UPDATE games SET seq = ${nextSeq}, current_seat = ${nextSeat}, status = ${nextStatus},
      state = ${JSON.stringify(serialize(g.state))}, last_turn = ${JSON.stringify(lastTurn)}, updated_at = now()
      WHERE room_id = ${code} AND seq = ${seq}
      RETURNING seq`;
    if (!Array.isArray(upd) || upd.length === 0) {
      // Someone else's write landed between our read and write. Treat as a
      // stale collision and let the caller adopt + retry.
      const fresh = await sql`SELECT seq, current_seat, status, state FROM games WHERE room_id = ${code}`;
      const f = fresh[0] || { seq, current_seat: nextSeat, status: nextStatus, state: null };
      const redacted = f.state ? redactStateForSeat(f.state, seat) : null;
      return json(409, { error: "stale", seq: Number(f.seq), state: redacted, status: f.status, currentSeat: f.current_seat });
    }

    const redacted = redactStateForSeat(g.state, seat);
    const out = {
      ok: true,
      seq: nextSeq,
      currentSeat: nextSeat,
      status: nextStatus,
      state: redacted,
      lastTurn,
    };
    // drawnCard goes ONLY to the actor; it's not in lastTurn so spectators
    // never see it.
    if (result.drawnCard) out.drawnCard = result.drawnCard;
    if (noWayOutTriggered) out.noWayOut = true;
    return json(200, out);
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

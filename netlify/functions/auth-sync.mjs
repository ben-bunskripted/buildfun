// Upsert the signed-in user's profile row. Called by the client right after
// Netlify Identity login so the DB has a stable uid -> display name mapping.

import { db, getUser, json, parseBody, checkBodySize, rateLimit } from "./_lib.mjs";

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
  const tooBig = checkBodySize(event, 4 * 1024);
  if (tooBig) return tooBig;
  const user = getUser(context);
  if (!user) return json(401, { error: "sign-in required" });
  const sql = db();
  const limited = await rateLimit(sql, user, "auth-sync");
  if (limited) return limited;
  const { displayName } = parseBody(event);
  const name = (displayName || user.name || "Player").toString().trim().slice(0, 40) || "Player";
  try {
    await sql`
      INSERT INTO users (uid, display_name) VALUES (${user.uid}, ${name})
      ON CONFLICT (uid) DO UPDATE SET display_name = EXCLUDED.display_name`;
    return json(200, { ok: true, uid: user.uid, displayName: name });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
};

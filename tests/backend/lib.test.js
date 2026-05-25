import { describe, it, expect } from "vitest";
import {
  hashPassword, verifyPassword, makeRoomCode, getUser,
  json, notModified, parseBody, checkBodySize,
  canonicalDisplayName, countActiveRoomsForUser, rateLimit,
  MAX_ACTIVE_ROOMS_PER_USER,
} from "../../netlify/functions/_lib.mjs";

// A fake Neon tagged-template that returns canned rows regardless of query.
const fakeSql = (rows) => () => Promise.resolve(rows);

describe("password hashing", () => {
  it("produces a versioned pbkdf2 hash that verifies", async () => {
    const stored = await hashPassword("hunter2");
    expect(stored.startsWith("pbkdf2$")).toBe(true);
    expect(await verifyPassword("hunter2", stored)).toBe(true);
  });
  it("rejects the wrong password", async () => {
    const stored = await hashPassword("hunter2");
    expect(await verifyPassword("nope", stored)).toBe(false);
  });
  it("salts independently (two hashes of the same password differ)", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });
  it("returns false (not throw) for empty/garbage stored hashes", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$bad")).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
  });
  it("still accepts a legacy salt$sha256 hash", async () => {
    // Build a legacy hash the same way the old code did: SHA-256("salt:pw").
    const saltHex = "abcd";
    const data = new TextEncoder().encode(`${saltHex}:legacypw`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    const hex = [...digest].map(b => b.toString(16).padStart(2, "0")).join("");
    expect(await verifyPassword("legacypw", `${saltHex}$${hex}`)).toBe(true);
    expect(await verifyPassword("wrong", `${saltHex}$${hex}`)).toBe(false);
  });
});

describe("makeRoomCode", () => {
  it("uses the unambiguous alphabet and the requested length", () => {
    for (let i = 0; i < 200; i++) {
      const code = makeRoomCode(5);
      expect(code).toHaveLength(5);
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
      expect(code).not.toMatch(/[01OI]/);
    }
  });
});

describe("getUser", () => {
  it("normalizes a valid Identity context", () => {
    const u = getUser({ clientContext: { user: { sub: "u1", email: "a@b.co", user_metadata: { full_name: "Ada" } } } });
    expect(u).toEqual({ uid: "u1", email: "a@b.co", name: "Ada" });
  });
  it("returns null without a subject", () => {
    expect(getUser({})).toBeNull();
    expect(getUser({ clientContext: { user: {} } })).toBeNull();
  });
  it("falls back to email then 'Player' for the name, capped at 40 chars", () => {
    expect(getUser({ clientContext: { user: { sub: "u", email: "x@y.z" } } }).name).toBe("x@y.z");
    const long = "n".repeat(60);
    expect(getUser({ clientContext: { user: { sub: "u", user_metadata: { name: long } } } }).name).toHaveLength(40);
  });
});

describe("HTTP helpers", () => {
  it("json sets no-store + content-type and serializes the body", () => {
    const r = json(200, { ok: true });
    expect(r.statusCode).toBe(200);
    expect(r.headers["Content-Type"]).toBe("application/json");
    expect(r.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(r.body)).toEqual({ ok: true });
  });
  it("notModified wraps the etag in quotes", () => {
    const r = notModified("7-123");
    expect(r.statusCode).toBe(304);
    expect(r.headers.ETag).toBe('"7-123"');
  });
  it("parseBody tolerates bad JSON", () => {
    expect(parseBody({ body: '{"a":1}' })).toEqual({ a: 1 });
    expect(parseBody({ body: "garbage" })).toEqual({});
    expect(parseBody({})).toEqual({});
  });
  it("checkBodySize returns 413 only past the limit", () => {
    expect(checkBodySize({ body: "ab" }, 10)).toBeNull();
    expect(checkBodySize({ body: "x".repeat(11) }, 10).statusCode).toBe(413);
  });
});

describe("SQL-backed helpers (mocked)", () => {
  it("canonicalDisplayName prefers the DB name, trimmed to 40", async () => {
    const name = await canonicalDisplayName(fakeSql([{ display_name: "  DbName  " }]), { uid: "u", name: "JwtName" });
    expect(name).toBe("DbName");
  });
  it("canonicalDisplayName falls back to the JWT name when no row", async () => {
    const name = await canonicalDisplayName(fakeSql([]), { uid: "u", name: "JwtName" });
    expect(name).toBe("JwtName");
  });
  it("countActiveRoomsForUser coerces the count", async () => {
    expect(await countActiveRoomsForUser(fakeSql([{ n: 3 }]), "u")).toBe(3);
    expect(await countActiveRoomsForUser(fakeSql([]), "u")).toBe(0);
  });

  it("rateLimit returns null within budget and 429 over it", async () => {
    const user = { uid: "u" };
    expect(await rateLimit(fakeSql([{ total: 5 }]), user, "apply-action")).toBeNull();
    const over = await rateLimit(fakeSql([{ total: 9999 }]), user, "create-room");
    expect(over.statusCode).toBe(429);
  });
  it("rateLimit is a no-op for unauthenticated callers", async () => {
    expect(await rateLimit(fakeSql([{ total: 9999 }]), null, "create-room")).toBeNull();
  });
  it("rateLimit fails open if the DB throws", async () => {
    const throwingSql = () => Promise.reject(new Error("db down"));
    expect(await rateLimit(throwingSql, { uid: "u" }, "create-room")).toBeNull();
  });
});

describe("constants", () => {
  it("exposes the active-room cap", () => {
    expect(MAX_ACTIVE_ROOMS_PER_USER).toBe(10);
  });
});

#!/usr/bin/env node
// Fail if client "shell" files changed without bumping the service-worker cache
// version (the CACHE constant in sw.js). The cache key is what forces installed
// PWAs (and anything behind the cache-first SW) to re-fetch updated assets —
// forgetting to bump it ships code that never reaches users. This exact mistake
// went unnoticed across several deploys, so this check gates it on every PR.
//
// Usage:
//   node scripts/check-cache-bump.mjs [baseRef]
//   BASE_REF=<sha|ref> node scripts/check-cache-bump.mjs
// Defaults the comparison base to origin/main.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SW_PATH = "projects/benny-card-game/sw.js";
// Files served through the cache-first service worker. A change to any of these
// requires a cache bump. sw.js itself is excluded — it's where the bump lives.
const SHELL_RE = /^projects\/benny-card-game\/.*\.(js|css|html|webmanifest)$/;

const base = process.env.BASE_REF || process.argv[2] || "origin/main";

function git(args) {
  return execSync(`git ${args}`, { encoding: "utf8" }).trim();
}
function extractCache(src) {
  const m = src && src.match(/const\s+CACHE\s*=\s*["'`]([^"'`]+)["'`]/);
  return m ? m[1] : null;
}
function ok(msg) { console.log(`[cache-bump] ${msg}`); process.exit(0); }
function fail(msg) { console.error(`[cache-bump] FAIL: ${msg}`); process.exit(1); }

// Resolve a usable base; skip gracefully if it isn't available (e.g. a shallow
// checkout that didn't fetch it) rather than blocking on infrastructure.
try { git(`rev-parse --verify ${base}^{commit}`); }
catch { ok(`base ref '${base}' not found — skipping check.`); }

const mergeBase = git(`merge-base ${base} HEAD`);
const changed = git(`diff --name-only ${mergeBase} HEAD`).split("\n").filter(Boolean);
const shellChanged = changed.filter((f) => SHELL_RE.test(f) && f !== SW_PATH);

if (shellChanged.length === 0) ok("no client shell files changed — nothing to enforce.");

const headCache = extractCache(readFileSync(SW_PATH, "utf8"));
if (!headCache) {
  fail(`couldn't find the CACHE constant in ${SW_PATH} — has its format changed?`);
}

let baseCache = null;
try { baseCache = extractCache(git(`show ${mergeBase}:${SW_PATH}`)); } catch { /* sw.js new at base */ }

if (headCache !== baseCache) {
  ok(`shell files changed and CACHE bumped (${baseCache ?? "none"} -> ${headCache}) — OK.`);
}

fail(
  `client shell files changed but the service-worker CACHE in ${SW_PATH} was NOT bumped.\n` +
  `  CACHE is still "${headCache}".\n` +
  `  Changed shell files:\n${shellChanged.map((f) => `    - ${f}`).join("\n")}\n` +
  `  Fix: bump CACHE (e.g. "${headCache}" -> next version) in ${SW_PATH}, and keep APP_BUILD\n` +
  `  in projects/benny-card-game/js/main.js in sync, so installed PWAs re-fetch the update.`,
);

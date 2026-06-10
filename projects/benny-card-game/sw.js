// Bump this on any deploy that changes shell files.
const CACHE = "benny-v89";

const CARD_NAMES = [
  "1B","1J","2B","2J","2C","2D","2H","2S","3C","3D","3H","3S",
  "4C","4D","4H","4S","5C","5D","5H","5S","6C","6D","6H","6S",
  "7C","7D","7H","7S","8C","8D","8H","8S","9C","9D","9H","9S",
  "AC","AD","AH","AS","JC","JD","JH","JS","KC","KD","KH","KS",
  "QC","QD","QH","QS","TC","TD","TH","TS",
];

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./js/main.js",
  "./js/cards.js",
  "./js/game.js",
  "./js/scoring.js",
  "./js/rules.js",
  "./js/ai.js",
  "./js/dragdrop.js",
  "./js/rng.js",
  "./js/storage.js",
  "./js/profiles.js",
  "./js/achievements.js",
  "./js/tutorial.js",
  "./js/net.js",
  "./js/online.js",
  "./js/sw-register.js",
  "./assets/netlify-identity-widget.js",
  "./assets/favicon.png",
  "./assets/logo-bg.png",
  "./assets/icon-192-v4.png",
  "./assets/icon-512-v4.png",
  "./assets/icon-192-maskable-v4.png",
  "./assets/icon-512-maskable-v4.png",
  "./assets/screenshot-wide.png",
  "./assets/screenshot-narrow.png",
  ...CARD_NAMES.map(n => `./assets/cards/${n}.svg`),
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    // Don't auto-skipWaiting — let the page detect the waiting worker and
    // prompt the user to refresh. We honor a SKIP_WAITING message from the
    // page when they click "Refresh" on the update banner.
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // Let POSTs (e.g. Netlify feedback) pass through.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Online-multiplayer API calls and Netlify Identity (gotrue) requests must
  // always hit the network — never serve a cached (stale) poll response or a
  // stale /user|/settings auth response (which would also ignore the request's
  // Authorization header and could leak a previous user's data across logins).
  if (url.pathname.startsWith("/.netlify/functions/") ||
      url.pathname.startsWith("/.netlify/identity/") ||
      url.pathname.startsWith("/api/")) return;

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (_err) {
      // Offline + uncached navigation → fall back to the shell.
      if (req.mode === "navigate") return caches.match("./index.html");
      return Response.error();
    }
  })());
});

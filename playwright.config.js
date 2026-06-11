import { defineConfig, devices } from "@playwright/test";

// Drives the buildless static client through a real browser. The dev server is
// just Python's http.server rooted at the game directory (the same command the
// project README uses).
const PORT = 8123;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    // The PWA service worker reloads the page on first activation
    // (controllerchange -> location.reload), which races the tests. Block it.
    serviceWorkers: "block",
  },
  webServer: {
    command: `python3 -m http.server ${PORT} --directory projects/benny-card-game`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  // Chromium runs everywhere. WebKit (~ Safari, the project's stated target) and
  // Firefox are opt-in via PW_ALL_BROWSERS=1 — handy locally / in CI where those
  // browsers are installed, but skipped in sandboxes that only ship Chromium.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    ...(process.env.PW_ALL_BROWSERS
      ? [
          { name: "webkit", use: { ...devices["Desktop Safari"] } },
          { name: "firefox", use: { ...devices["Desktop Firefox"] } },
        ]
      : []),
  ],
});

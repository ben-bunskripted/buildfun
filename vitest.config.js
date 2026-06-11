import { defineConfig } from "vitest/config";

// Unit tests run under Vitest. Browser end-to-end tests live in
// tests/e2e and are driven by Playwright (separate runner) — excluded here.
export default defineConfig({
  test: {
    include: [
      "tests/unit/**/*.test.js",
      "tests/dom/**/*.test.js",
    ],
    environment: "node",
  },
});

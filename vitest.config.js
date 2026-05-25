import { defineConfig } from "vitest/config";

// Unit + backend tests run under Vitest. Browser end-to-end tests live in
// tests/e2e and are driven by Playwright (separate runner) — excluded here.
export default defineConfig({
  test: {
    include: [
      "tests/unit/**/*.test.js",
      "tests/dom/**/*.test.js",
      "tests/backend/**/*.test.js",
    ],
    environment: "node",
  },
});

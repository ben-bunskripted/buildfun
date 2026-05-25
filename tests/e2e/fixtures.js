import { test as base, expect } from "@playwright/test";

// Seed a username into prefs before any app code runs, so the first-launch
// welcome modal (which otherwise intercepts clicks) never appears.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      localStorage.setItem("benny:prefs:v1", JSON.stringify({ userName: "Tester" }));
    });
    await use(page);
  },
});

export { expect };

import { test, expect } from "./fixtures.js";

test("loads the start screen", async ({ page }) => {
  await page.goto("/index.html");
  await expect(page).toHaveTitle("Benny");
  await expect(page.locator("#screen-start")).toBeVisible();
  await expect(page.locator(".mode-tile")).toHaveCount(4);
});

test("picking Solo reveals the config step", async ({ page }) => {
  await page.goto("/index.html");
  await page.locator('.mode-tile[data-pick-mode="cpu"]').click();
  await expect(page.locator("#start-config-step")).toBeVisible();
  await expect(page.locator("#mode-cpu")).toBeVisible();
  await expect(page.locator("#start-btn")).toBeVisible();
});

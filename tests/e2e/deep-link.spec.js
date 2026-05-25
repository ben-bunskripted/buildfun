import { test, expect } from "./fixtures.js";

// The shareable link is /?join=CODE. On load it should drop the user straight
// on the Online tab with the code pre-filled, ready to join. Auto-join itself
// needs Netlify Identity + the backend (unavailable here), so signed-out we
// verify the landing + pre-fill and that nothing throws.
test("?join=CODE lands on the Online tab with the code pre-filled", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/index.html?join=abcde");

  await expect(page.locator("#start-config-step")).toBeVisible();
  await expect(page.locator("#mode-online")).toBeVisible();
  await expect(page.locator("#online-join-code")).toHaveValue("ABCDE");

  // The deep-link param is stripped so a refresh doesn't re-trigger it.
  expect(new URL(page.url()).searchParams.has("join")).toBe(false);

  expect(errors).toEqual([]);
});

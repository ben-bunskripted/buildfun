import { test, expect } from "./fixtures.js";

// Start a Solo (vs CPU) match with the human as a fixed dealer. A fixed dealer
// skips the random "reveal" reel, and the dealer opens first — so we land on
// the play screen directly with the human to act.
async function startSoloAsDealer(page) {
  await page.goto("/index.html");
  await page.locator('.mode-tile[data-pick-mode="cpu"]').click();
  await expect(page.locator("#mode-cpu")).toBeVisible();
  const sel = page.locator("#solo-dealer-select");
  await sel.selectOption("0"); // "You" = dealer (skips the random reveal)
  await expect(sel).toHaveValue("0");
  await page.locator("#start-btn").click();
  // Safety net: if a random reveal ever interposes, advance past it.
  const reveal = page.locator("#screen-reveal");
  if (await reveal.isVisible().catch(() => false)) {
    await page.locator("#reveal-continue").click();
  }
  await expect(page.locator("#screen-play")).toBeVisible();
}

test("deal lands on the play screen with the dealer's 8-card hand", async ({ page }) => {
  await startSoloAsDealer(page);
  // The dealer is dealt 7 + 1 extra.
  await expect(page.locator("#hand .card")).toHaveCount(8);
  await expect(page.locator("#discard-btn")).toBeVisible();
});

test("selecting a card enables Discard and ending the turn moves the card to the pile", async ({ page }) => {
  await startSoloAsDealer(page);

  // Nothing selected yet -> Discard disabled.
  await expect(page.locator("#discard-btn")).toBeDisabled();

  await page.locator("#hand .card").first().click();
  await expect(page.locator("#discard-btn")).toBeEnabled();

  await page.locator("#discard-btn").click();

  // The discarded card is now the top of the discard pile, and our hand shrank.
  await expect(page.locator("#discard-host .card")).toBeVisible();
  await expect(page.locator("#hand .card")).toHaveCount(7);
});

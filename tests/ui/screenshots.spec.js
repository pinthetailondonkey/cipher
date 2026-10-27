import { test } from '@playwright/test';
import { seedVault } from './fixtures.js';

// TODO (one-and-done merge): the parallel rebuild PRs re-skin every screen.
// Baselines captured now would all misfire at the merge commit; park the
// captures until the shell lands, then re-baseline per docs/UI-NOTES.md #8.
test.describe.skip('Visual regression', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(seedVault);
  });

  test('screenshot: home screen', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'test-results/home.png', fullPage: true });
  });

  test('screenshot: explore tab', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Click explore tab if visible
    const exploreBtn = page.locator('button:has-text("Shop")').or(page.locator('button:has-text("Explore")'));
    if (await exploreBtn.count() > 0) {
      await exploreBtn.first().click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'test-results/explore.png', fullPage: true });
    }
  });

  test('screenshot: profile tab', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    const profileBtn = page.locator('button:has-text("Profile")');
    if (await profileBtn.count() > 0) {
      await profileBtn.first().click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'test-results/profile.png', fullPage: true });
    }
  });
});

import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

// Test(-receipt) screenshots over the merged tree: the rebuild shell has
// landed, so the parked captures run again (UI-NOTES #8). These are
// receipts, not pixel-compare baselines — full-page dark-skin captures at
// the phone project, kept under test-results/ (gitignored) and named per
// screen. Each shot waits for real content (the skeleton rows the boot
// paints first are not the screen), never a fixed clock.
test.describe('Visual regression', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(seedVault);
  });

  test('screenshot: home screen', async ({ page }) => {
    await page.goto('/');
    // The chat list is the home screen's own content; the boot skeleton
    // has no heading, so this wait separates boot paint from screen.
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-results/home.png', fullPage: true });
  });

  test('screenshot: explore tab', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 20000 });
    // Phone project: the md+ rail is display-none here — navigation is the
    // drawer, so open it and tap the Menus door inside it.
    await page.getByRole('button', { name: 'Open menu' }).click();
    const menusDoor = page.getByRole('button', { name: 'Menus' }).or(page.getByRole('button', { name: 'Explore' }));
    await expect(menusDoor.first()).toBeVisible({ timeout: 10000 });
    await menusDoor.first().click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/explore.png', fullPage: true });
  });

  test('screenshot: profile tab', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 20000 });
    // Same phone door: the drawer's "Orders" entry opens the profile tab's
    // Wallet view (the drawer's own label for it).
    await page.getByRole('button', { name: 'Open menu' }).click();
    const profileDoor = page.getByRole('button', { name: 'Orders' });
    await expect(profileDoor).toBeVisible({ timeout: 10000 });
    await profileDoor.first().click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/profile.png', fullPage: true });
  });
});

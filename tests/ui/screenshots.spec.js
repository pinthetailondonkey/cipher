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
    // Phone project: the md+ rail is display-none here — the bottom bar is
    // the nav (15.1), so tap the Menus tab straight off it.
    const menusDoor = page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'Menus' });
    await expect(menusDoor).toBeVisible({ timeout: 10000 });
    await menusDoor.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/explore.png', fullPage: true });
  });

  test('screenshot: profile tab', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 20000 });
    // Same phone nav: the bar's Profile tab opens the Wallet pane.
    const profileDoor = page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'Profile' });
    await expect(profileDoor).toBeVisible({ timeout: 10000 });
    await profileDoor.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/profile.png', fullPage: true });
  });

  test('screenshot: onboarding', async ({ page }) => {
    // No vault, no session: the first screen a new device shows. The seeded
    // identity above must not run here, so the vault is cleared first.
    await page.addInitScript(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch { /* a browser without storage still shows the first screen */ }
    });
    await page.goto('/');
    // The first screen's own heading; the boot paint has none.
    await expect(page.getByRole('heading', { name: 'Welcome to Cipher' })).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-results/onboarding.png', fullPage: true });
  });
});

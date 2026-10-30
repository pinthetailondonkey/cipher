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

// The conversation and settings receipts the founder asked for at the first
// layout checkpoint. Both use a synthetic peer and synthetic words: no real
// key, no recovery phrase, nothing from an account.
test.describe('Visual regression — conversation and settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(seedVault);
  });

  test('screenshot: conversation', async ({ page }) => {
    const peerPk = 'f'.repeat(64);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 20000 });
    // Let the boot's own history fetch settle first: a fetch that lands after
    // the seed would replace the store's copy with the relay's empty one.
    await page.waitForTimeout(2000);
    // The list reads the store's own dms map, so the synthetic thread is put
    // there through the UI-test seam — two messages, nothing from a real
    // account, no key material.
    await page.evaluate(async (pk) => {
      const store = window.__cipherStore;
      if (!store) throw new Error('window.__cipherStore missing — UI-test seam did not load');
      const now = Math.floor(Date.now() / 1000);
      store.setState({
        dms: {
          [pk]: [
            { id: 'shot-1', pubkey: pk, timestamp: now - 300, data: { message: 'Are we still on for Friday?', type: 'text' }, isSender: false },
            { id: 'shot-2', pubkey: pk, timestamp: now - 240, data: { message: 'Yes, same place as last time.', type: 'text' }, isSender: true },
          ],
        },
      });
    }, peerPk);
    // A chat this device has not opened before shows its preview blurred, so
    // the row is found by its name control rather than its preview text.
    const row = page.getByRole('button', { name: /^npub1/ });
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.click();
    await expect(page.getByRole('button', { name: 'Chat options' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Are we still on for Friday?')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'test-results/conversation.png', fullPage: true });
  });

  test('screenshot: settings', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 20000 });
    const profileDoor = page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'Profile' });
    await expect(profileDoor).toBeVisible({ timeout: 10000 });
    await profileDoor.click();
    const privacy = page.getByRole('button', { name: /Privacy/i }).first();
    await expect(privacy).toBeVisible({ timeout: 10000 });
    await privacy.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'test-results/settings.png', fullPage: true });
  });
});

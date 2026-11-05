import { test, expect } from '@playwright/test';
import { TEST_PIN, TEST_PK, TEST_SK, seedVault, unlock } from './fixtures.js';

// What a boot carries, now that the raw secret lives in memory for the tab's
// lifetime (src/lib/sessionKey.js): nothing at all.
//
// The old contract was a saved session riding over the reload, gated by which
// envelope it sat on. With no copy of the key in storage there is nothing to
// ride and nothing to gate: every load asks the vault's own door, and a vault
// that is not locked to this device is wrapped at that unlock, so the next
// load asks the door again over the wrapped vault.
//
// These specs pin that, so a restore block quietly creeping back into boot
// fails here rather than passing as a convenience.

const lockScreen = (page) => page.getByRole('heading', { name: 'Unlock Cipher' });
const staffedTabs = (page) => page.getByRole('navigation', { name: 'Tabs' });

const vaultOf = (page) => page.evaluate(
  (pk) => JSON.parse(localStorage.getItem('cipher_vaults') || '{}')?.[pk]?.vault,
  TEST_PK,
);

test.describe('Boot carries no session: the vault is the only door', () => {
  test('a planted session is not read, and is not cleaned either', async ({ page }) => {
    // Exactly what the old fixture wrote: the raw key, in sessionStorage. A
    // boot that still reads it would land in the app; this boot does not.
    await page.addInitScript(({ sk }) => {
      sessionStorage.setItem('cipher_session_sk', JSON.stringify(sk));
    }, { sk: TEST_SK });
    await page.addInitScript(seedVault);
    await page.goto('/');

    await expect(lockScreen(page)).toBeVisible({ timeout: 15000 });
    await expect(staffedTabs(page)).toBeHidden();
    // Left where it was: nothing removes it, because nothing looked. A build
    // that read it would have wiped it and sat in the app instead.
    expect(await page.evaluate(() => sessionStorage.getItem('cipher_session_sk'))).not.toBeNull();
  });

  test('the PIN opens it and the unwrapped vault is locked to this device at that unlock', async ({ page }) => {
    await page.addInitScript(seedVault);
    await page.goto('/');

    const seeded = await vaultOf(page);
    expect(seeded.v).toBeUndefined(); // the seed is a PIN envelope, not a device one
    await expect(lockScreen(page)).toBeVisible({ timeout: 15000 });

    await unlock(page);
    await expect(staffedTabs(page)).toBeVisible({ timeout: 20000 });
    await expect(lockScreen(page)).toBeHidden();

    // The wrap happened inside the unlock, in place: the same account, now
    // behind the device layer.
    expect((await vaultOf(page)).v).toBe(3);
  });

  test('a reload asks again, and the wrapped vault opens with the same PIN', async ({ page }) => {
    // Two full boots, each one a PBKDF2 derivation and a WebAuthn round trip.
    test.slow();
    // One-shot seed: the reload must meet the vault the app itself wrote,
    // not the fixture's copy of it.
    await page.addInitScript(seedVault, { once: true });
    await page.goto('/');
    await unlock(page);
    await expect(staffedTabs(page)).toBeVisible({ timeout: 20000 });
    expect((await vaultOf(page)).v).toBe(3);

    // In memory, not storage: the reload carries no key and the gate is back.
    await page.reload();
    await expect(lockScreen(page)).toBeVisible({ timeout: 15000 });
    await expect(staffedTabs(page)).toBeHidden();
    expect((await vaultOf(page)).v).toBe(3); // the seed did not replay over it

    // The device-wrapped vault opens with the same PIN, device layer and all.
    await unlock(page, TEST_PIN);
    await expect(staffedTabs(page)).toBeVisible({ timeout: 20000 });
  });
});

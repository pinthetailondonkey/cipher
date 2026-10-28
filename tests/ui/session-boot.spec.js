import { test, expect } from '@playwright/test';
import { getPublicKey } from 'nostr-tools';

// What a saved session may and may not ride over at boot. Every account must
// be locked to its device; a vault that was never wrapped gets wrapped at its
// next unlock, and a session minted before that law can outlive it — a tab
// carries its sessionStorage across the reload that swaps in this build. Boot
// is the gate: a session over an unwrapped vault is thrown out (the unlock
// that wraps it asks for the PIN), and a session over a device vault is the
// one case that restores with no prompt at all, reload after reload.

const SK = Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const PK = getPublicKey(Uint8Array.from(SK));

// The PIN vault the app itself writes (src/useIdentity.js encryptKey):
// PBKDF2-SHA256 + AES-GCM, {iv, data, salt, iter}. Here unwrapped — a vault
// from before every vault was born inside the device envelope.
async function pinOnlyVault(pin) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey('raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(SK)));
  return {
    iv: Array.from(iv), data: Array.from(new Uint8Array(ct)), salt: Array.from(salt), iter: 600000,
  };
}

// A vault that answers the device-envelope shape (vault.v === 3). Boot never
// opens it — the gate reads the shape — so the bytes are dummies; the session
// holds the real key.
const deviceShapedVault = () => ({ v: 3, dk: { k: 'prf', id: 'seeded' }, iv: [1, 2, 3], data: [4, 5, 6] });

// Seeds a finished account with a live session. One-shot: the app may drop the
// session on boot, and a replaying seed would hand it back and test the seed.
async function seedSession(page, { vault }) {
  await page.addInitScript(({ pk, vault, sk }) => {
    if (sessionStorage.getItem('cipher_session_seeded')) return;
    sessionStorage.setItem('cipher_session_seeded', '1');
    sessionStorage.setItem('cipher_session_sk', JSON.stringify(sk));
    localStorage.setItem('cipher_vaults', JSON.stringify({
      [pk]: { vault, handle: 'alice', displayName: 'Alice', createdAt: 1700000000000, confirmed: true },
    }));
    localStorage.setItem('cipher_active_pubkey', pk);
  }, { pk: PK, vault, sk: SK });
}

const lockScreen = (page) => page.getByRole('heading', { name: 'Unlock Cipher' });
const staffedTabs = (page) => page.getByRole('navigation', { name: 'Tabs' });

test.describe('Boot gates a saved session by the device-lock migration', () => {
  test('a legacy session over an unwrapped vault is thrown out: boot lands on the PIN gate', async ({ page }) => {
    // The migration runs at the next unlock, so boot must not let the old
    // session skip it. The account is still there — the 12 words and the PIN
    // path are untouched — but the tab is locked until the wrap has happened.
    await seedSession(page, { vault: await pinOnlyVault('87654321') });
    await page.goto('/');
    await expect(lockScreen(page)).toBeVisible({ timeout: 15000 });
    await expect(staffedTabs(page)).toBeHidden();
    // And the stale session itself is gone, not merely ignored.
    expect(await page.evaluate(() => sessionStorage.getItem('cipher_session_sk'))).toBeNull();
  });

  test('a session over a device vault restores with no prompt, and keeps restoring on every reload', async ({ page }) => {
    // An account that completed the migration is the one case that never asks:
    // boot restores the session straight into the app, and a reload restores
    // it again. No authentication prompt rides along.
    await seedSession(page, { vault: deviceShapedVault() });
    await page.goto('/');
    await expect(staffedTabs(page)).toBeVisible({ timeout: 20000 });
    await expect(lockScreen(page)).toBeHidden();

    // The reload is not a prompt either, and it is not the seed answering:
    // the one-shot flag means the second boot runs on whatever the app left
    // in the session slot.
    await page.reload();
    await expect(staffedTabs(page)).toBeVisible({ timeout: 20000 });
    await expect(lockScreen(page)).toBeHidden();
  });
});

import { test, expect } from '@playwright/test';
import { getPublicKey } from 'nostr-tools';
import { unlock } from './fixtures.js';

// The full legacy switch, run where the device key can really be made:
// Chromium's virtual authenticator answers the PRF prompt. What this proves
// end to end: an old no-salt PIN vault, opened with its legitimate PIN through
// the real Accounts screen, is wrapped to this device, written back, made
// active, and — the reload carrying no key — opens again on the gate over its
// now-wrapped vault, with the PIN that always opened it.
//
// The authenticator comes from tests/ui/fixtures.js: the unlock below is what
// installs it, which is also why A's vault here is real rather than the
// device-shaped shell it used to be (nothing carried A's key past boot).

const SK_A = Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff);
const PK_A = getPublicKey(Uint8Array.from(SK_A));
const SK_B = Array.from({ length: 32 }, (_, i) => (i * 9 + 7) & 0xff);
const PK_B = getPublicKey(Uint8Array.from(SK_B));
// A is the account the gate opens first, before the switch takes B.
const PIN_A = '11111111';

async function legacyVault(sk, pin) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('cipher_secure_salt'), iterations: 100000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(sk)));
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(ct)) };
}

test('a legacy no-salt PIN vault switches with the right PIN and comes back wrapped', async ({ page }) => {
  test.setTimeout(120000);
  const vaultB = await legacyVault(SK_B, '123456');
  const vaultA = await legacyVault(SK_A, PIN_A);
  await page.addInitScript(({ pkA, pkB, vaultA, vaultB }) => {
    if (localStorage.getItem('cipher_switch_prf_seeded')) return;
    localStorage.setItem('cipher_switch_prf_seeded', '1');
    localStorage.setItem('cipher_vaults', JSON.stringify({
      [pkA]: { vault: vaultA, handle: 'active', displayName: 'Active Account', createdAt: 1700000000000, confirmed: true },
      [pkB]: { vault: vaultB, handle: 'target', displayName: 'Target Account', createdAt: 1700000001000, confirmed: true },
    }));
    localStorage.setItem('cipher_active_pubkey', pkA);
  }, { pkA: PK_A, pkB: PK_B, vaultA, vaultB });

  await page.goto('/');
  // The gate, and the authenticator the PRF prompt will need is installed by
  // this call — after the page is up, exactly as devicePrf.spec.js does it.
  await unlock(page, PIN_A);
  await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeVisible({ timeout: 20000 });

  await page.getByRole('button', { name: 'You', exact: true }).click();
  await page.getByRole('button', { name: /Accounts/ }).click();
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();

  await page.getByPlaceholder('PIN').fill('123456');
  await page.getByRole('button', { name: 'Switch', exact: true }).click();

  // The switch ends in its own reload, but the wrap takes real work first
  // (a 600k-iteration encrypt, the authenticator, a full verify open), so
  // the outcome is polled, not assumed the moment the button goes quiet.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cipher_active_pubkey')), { timeout: 60000 }).toBe(PK_B);
  await page.waitForTimeout(1500);
  // The reload carries no key, so the gate is back — over B's vault, which the
  // same PIN that always opened it opens again, device layer and all.
  await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeVisible({ timeout: 30000 });
  await unlock(page, '123456');
  await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeHidden();
  const entry = await page.evaluate((pk) => JSON.parse(localStorage.getItem('cipher_vaults'))[pk], PK_B);
  expect(entry.vault.v).toBe(3);
  expect(entry.vault.dk.k).toBe('prf');
  // Nothing was spent getting here, and the old PIN is not remembered.
  expect(await page.evaluate((pk) => localStorage.getItem(`cipher_fails_${pk}`), PK_B)).toBeNull();
});

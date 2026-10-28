import { test, expect } from '@playwright/test';
import { getPublicKey } from 'nostr-tools';

// The full legacy switch, run where the device key can really be made:
// Chromium's virtual authenticator answers the PRF prompt (the iphone
// project has no authenticator, so the wrap can only be observed up to the
// prompt there — see account-switch.spec.js). What this proves end to end:
// an old no-salt PIN vault, opened with its legitimate PIN through the real
// Accounts screen, is wrapped to this device, written back, made active,
// and the reload boots straight onto it with no PIN gate.

const SK_A = Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff);
const PK_A = getPublicKey(Uint8Array.from(SK_A));
const SK_B = Array.from({ length: 32 }, (_, i) => (i * 9 + 7) & 0xff);
const PK_B = getPublicKey(Uint8Array.from(SK_B));

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
  await page.addInitScript(({ pkA, pkB, skA, vaultA, vaultB }) => {
    if (sessionStorage.getItem('cipher_switch_prf_seeded')) return;
    sessionStorage.setItem('cipher_switch_prf_seeded', '1');
    sessionStorage.setItem('cipher_session_sk', JSON.stringify(skA));
    localStorage.setItem('cipher_vaults', JSON.stringify({
      [pkA]: { vault: vaultA, handle: 'active', displayName: 'Active Account', createdAt: 1700000000000, confirmed: true },
      [pkB]: { vault: vaultB, handle: 'target', displayName: 'Target Account', createdAt: 1700000001000, confirmed: true },
    }));
    localStorage.setItem('cipher_active_pubkey', pkA);
  }, {
    pkA: PK_A, pkB: PK_B, skA: SK_A,
    vaultA: { v: 3, dk: { k: 'prf', id: 'seeded' }, iv: [1, 2, 3], data: [4, 5, 6] },
    vaultB,
  });

  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeVisible({ timeout: 20000 });

  // The authenticator that answers the PRF prompt the wrap will raise. Added
  // after the page is up, exactly as devicePrf.spec.js does it.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true },
  });
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await page.getByRole('button', { name: /Accounts/ }).click();
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();

  await page.getByPlaceholder('PIN').fill('123456');
  await page.getByRole('button', { name: 'Switch', exact: true }).click();

  // The switch ends in its own reload, but the wrap takes real work first
  // (a 600k-iteration encrypt, the authenticator, a full verify open), so
  // the outcome is polled, not assumed the moment the button goes quiet.
  // Boot must come back on B, on B's wrapped vault, with no PIN gate.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cipher_active_pubkey')), { timeout: 60000 }).toBe(PK_B);
  await page.waitForTimeout(1500);
  await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeHidden();
  const entry = await page.evaluate((pk) => JSON.parse(localStorage.getItem('cipher_vaults'))[pk], PK_B);
  expect(entry.vault.v).toBe(3);
  expect(entry.vault.dk.k).toBe('prf');
  // Nothing was spent getting here, and the old PIN is not remembered.
  expect(await page.evaluate((pk) => localStorage.getItem(`cipher_fails_${pk}`), PK_B)).toBeNull();
});

import { test, expect } from '@playwright/test';
import { getPublicKey } from 'nostr-tools';

// switchAccount through its real door: the Accounts screen, typed PIN, the
// Switch button. Unlock already refuses to treat a damaged copy as a wrong
// PIN; the switch path must give the same answers — damage spends none of the
// five attempts, deletes no account, and a legitimate old PIN still switches.

const SK_A = Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff);
const PK_A = getPublicKey(Uint8Array.from(SK_A));
const SK_B = Array.from({ length: 32 }, (_, i) => (i * 9 + 7) & 0xff);
const PK_B = getPublicKey(Uint8Array.from(SK_B));

// The PIN vault the app itself writes (src/useIdentity.js encryptKey), and the
// no-salt shape from before per-vault salts. The switch path opens these for
// real, so B's vault must hold B's actual key.
async function pinVault(sk, pin, { legacy = false } = {}) {
  const enc = new TextEncoder();
  const salt = legacy ? enc.encode('cipher_secure_salt') : crypto.getRandomValues(new Uint8Array(16));
  const iterations = legacy ? 100000 : 600000;
  const material = await crypto.subtle.importKey('raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(sk)));
  const envelope = { iv: Array.from(iv), data: Array.from(new Uint8Array(ct)) };
  return legacy ? envelope : { ...envelope, salt: Array.from(salt), iter: iterations };
}

// A's vault only needs to satisfy boot's device-lock gate (v: 3); nothing in
// this spec opens it.
const deviceShapedVault = () => ({ v: 3, dk: { k: 'prf', id: 'seeded' }, iv: [1, 2, 3], data: [4, 5, 6] });

// One-shot seeding: a successful switch ends in its own reload, and a
// replaying seed would hand the app back the very vault it just wrapped.
async function seedTwoAccounts(page, { vaultB }) {
  await page.addInitScript(({ pkA, pkB, skA, vaultA, vaultB }) => {
    if (localStorage.getItem('cipher_switch_seeded')) return;
    localStorage.setItem('cipher_switch_seeded', '1');
    sessionStorage.setItem('cipher_session_sk', JSON.stringify(skA));
    localStorage.setItem('cipher_vaults', JSON.stringify({
      [pkA]: { vault: vaultA, handle: 'active', displayName: 'Active Account', createdAt: 1700000000000, confirmed: true },
      [pkB]: { vault: vaultB, handle: 'target', displayName: 'Target Account', createdAt: 1700000001000, confirmed: true },
    }));
    localStorage.setItem('cipher_active_pubkey', pkA);
  }, { pkA: PK_A, pkB: PK_B, skA: SK_A, vaultA: deviceShapedVault(), vaultB });
}

async function openSwitcher(page) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'You', exact: true }).click();
  await page.getByRole('button', { name: /Accounts/ }).click();
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
}

async function switchWithPin(page, pin) {
  await page.getByPlaceholder('PIN').fill(pin);
  await page.getByRole('button', { name: 'Switch', exact: true }).click();
}

const storedFailsB = (page) => page.evaluate((pk) => localStorage.getItem(`cipher_fails_${pk}`), PK_B);
const targetRow = (page) => page.getByText('Target Account');
const targetVault = (page) => page.evaluate((pk) => JSON.parse(localStorage.getItem('cipher_vaults'))[pk]?.vault, PK_B);

test.describe('switchAccount answers damage as damage, never as a wrong PIN', () => {
  test('five damaged-copy attempts spend nothing and delete nothing', async ({ page }) => {
    // Before the guard, each of these charged one of the five attempts, and
    // the fifth deleted the account outright. Damage no PIN could open must
    // answer on its own, all five times, and leave the entry exactly as it
    // was: the 12 words are the way back.
    const damaged = { iv: [1, 2, 3], data: 'not-a-byte-array' };
    await seedTwoAccounts(page, { vaultB: damaged });
    await openSwitcher(page);

    for (let i = 0; i < 5; i += 1) {
      await switchWithPin(page, '87654321');
      await expect(page.getByRole('alert')).toContainText('This device holds a damaged copy of the account. Use your 12 words.');
      expect(await storedFailsB(page)).toBeNull();
    }
    // The account is still on the list and still exactly as damaged as it
    // was — not removed, not wiped, not re-written.
    await expect(targetRow(page)).toBeVisible();
    expect(await targetVault(page)).toEqual(damaged);
  });

  test('an entry with no vault at all answers on its own and spends nothing', async ({ page }) => {
    // The entry exists, so the account is listed; the vault slot inside it
    // does not. No PIN could open that, and none may be charged for it.
    await seedTwoAccounts(page, { vaultB: undefined });
    await openSwitcher(page);
    await switchWithPin(page, '87654321');
    await expect(page.getByRole('alert')).toContainText('damaged copy');
    expect(await storedFailsB(page)).toBeNull();
    await expect(targetRow(page)).toBeVisible();
  });

  test('damaged KDF metadata is a damaged copy, not a wrong PIN', async ({ page }) => {
    // iv and data are whole, so only the guard's eyes for salt and iter
    // shape keep this from being handed to decryption and charged.
    const vault = await pinVault(SK_B, '87654321');
    const withBadSalt = { ...vault, salt: 'sixteen-bytes' };
    await seedTwoAccounts(page, { vaultB: withBadSalt });
    await openSwitcher(page);
    await switchWithPin(page, '87654321');
    await expect(page.getByRole('alert')).toContainText('damaged copy');
    expect(await storedFailsB(page)).toBeNull();
    expect(await targetVault(page)).toEqual(withBadSalt);

    await page.evaluate(({ pk, vault }) => {
      const vaults = JSON.parse(localStorage.getItem('cipher_vaults'));
      vaults[pk].vault = { ...vault, salt: vault.salt, iter: 'lots' };
      localStorage.setItem('cipher_vaults', JSON.stringify(vaults));
    }, { pk: PK_B, vault });
    await switchWithPin(page, '87654321');
    await expect(page.getByRole('alert')).toContainText('damaged copy');
    expect(await storedFailsB(page)).toBeNull();
  });
});

test.describe('switchAccount still switches a legitimate old account', () => {
  // The wrap itself needs an authenticator, which the iphone project has
  // none of: the full legacy switch, wrapped and reloaded, is proven in
  // account-switch.devicePrf.spec.js under Chromium's virtual authenticator.
  test('a correct PIN on a legacy vault is never told it is wrong, and spends nothing', async ({ page }) => {
    await seedTwoAccounts(page, { vaultB: await pinVault(SK_B, '123456', { legacy: true }) });
    await openSwitcher(page);
    await switchWithPin(page, '123456');
    // Give the device-key prompt time to settle either way, then read the
    // facts that do not depend on it: the PIN was right, so no attempt is
    // spent, nothing says "Wrong PIN", and the vault is untouched.
    await page.waitForTimeout(3000);
    expect(await storedFailsB(page)).toBeNull();
    const said = await page.evaluate(() => document.querySelector('[role="alert"]')?.textContent || '');
    expect(said).not.toContain('Wrong PIN');
    const vault = await targetVault(page);
    expect(vault.v).toBeUndefined();
    expect(vault.salt).toBeUndefined();
  });
});

import { test, expect } from '@playwright/test';
import { getPublicKey } from 'nostr-tools';
import { unlock } from './fixtures.js';

// switchAccount through its real door: the Accounts screen, typed PIN, the
// Switch button. Unlock already refuses to treat a damaged copy as a wrong
// PIN; the switch path must give the same answers — damage spends none of the
// five attempts, deletes no account, and a legitimate old PIN still switches.

const SK_A = Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff);
const PK_A = getPublicKey(Uint8Array.from(SK_A));
const SK_B = Array.from({ length: 32 }, (_, i) => (i * 9 + 7) & 0xff);
const PK_B = getPublicKey(Uint8Array.from(SK_B));
// The active account's own PIN. Boot carries no key any more, so A is opened
// through the gate like any account before this spec can switch away from it.
const PIN_A = '11111111';

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

// A's vault used to be a device-shaped shell no one opened, because the
// session in storage carried A's key. Nothing carries it now, so A's vault is
// real and the PIN opens it.
//
// One-shot seeding: a successful switch ends in its own reload, and a
// replaying seed would hand the app back the very vault it just wrapped.
async function seedTwoAccounts(page, { vaultB }) {
  const vaultA = await pinVault(SK_A, PIN_A);
  await page.addInitScript(({ pkA, pkB, vaultA, vaultB }) => {
    if (localStorage.getItem('cipher_switch_seeded')) return;
    localStorage.setItem('cipher_switch_seeded', '1');
    localStorage.setItem('cipher_vaults', JSON.stringify({
      [pkA]: { vault: vaultA, handle: 'active', displayName: 'Active Account', createdAt: 1700000000000, confirmed: true },
      [pkB]: { vault: vaultB, handle: 'target', displayName: 'Target Account', createdAt: 1700000001000, confirmed: true },
    }));
    localStorage.setItem('cipher_active_pubkey', pkA);
  }, { pkA: PK_A, pkB: PK_B, vaultA, vaultB });
}

async function openSwitcher(page) {
  await page.goto('/');
  await unlock(page, PIN_A);
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

// A read that survives the switch's own reload: an evaluate that is in flight
// when the page navigates rejects with "Execution context was destroyed", and
// the poll's next tick reads the fresh context. Without this the assertion is
// decided by whether the read happened to land during the reload.
const acrossReload = (page, fn, arg) => page.evaluate(fn, arg).catch(() => undefined);

test.describe('switchAccount answers damage as damage, never as a wrong PIN', () => {
  test('five damaged-copy attempts spend nothing and delete nothing', async ({ page }) => {
    test.slow(); // one boot, then five typed attempts on the switch screen
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
  // The gate installs a virtual authenticator for any spec that seeds and
  // unlocks (tests/ui/fixtures.js), so this arm has one too: a legitimate PIN
  // on B's unwrapped vault is wrapped here as well, device layer and all.
  // account-switch.devicePrf.spec.js proves the same wrap under its own.
  test('a correct PIN on a legacy vault is never told it is wrong, and spends nothing', async ({ page }) => {
    test.slow();
    await seedTwoAccounts(page, { vaultB: await pinVault(SK_B, '123456', { legacy: true }) });
    await openSwitcher(page);
    await switchWithPin(page, '123456');
    // The switch ends in a reload of its own, and the wrap underneath it is
    // real work (a 600k-iteration encrypt, the authenticator, a full verify
    // open), so both the pointer and the wrapped vault are polled rather than
    // read off a fixed clock that suite load can outlast.
    await expect.poll(() => acrossReload(page, () => localStorage.getItem('cipher_active_pubkey')), { timeout: 60000 }).toBe(PK_B);
    await expect.poll(() => acrossReload(page, (pk) => JSON.parse(localStorage.getItem('cipher_vaults'))?.[pk]?.vault?.v, PK_B), { timeout: 60000 }).toBe(3);
    // The facts that do not depend on that timing: the PIN was right, so no
    // attempt is spent and nothing says "Wrong PIN".
    expect(await storedFailsB(page)).toBeNull();
    const said = await page.evaluate(() => document.querySelector('[role="alert"]')?.textContent || '');
    expect(said).not.toContain('Wrong PIN');
    // Straight in: the vault left as a no-salt PIN envelope, and comes back
    // behind the device layer.
    const vault = await targetVault(page);
    expect(vault.salt).toBeUndefined();
    expect(vault.dk.k).toBe('prf');
  });
});

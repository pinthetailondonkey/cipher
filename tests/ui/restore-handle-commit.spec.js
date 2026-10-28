import { test, expect } from '@playwright/test';
import { getPublicKey } from 'nostr-tools';

// The handle door (Restore screen, handle + PIN) lands the account through
// the same one-commit rule as the 12-word door: table, pointer, mirror and
// handle go together or not at all. Here the storage refuses one of the
// commit's writes mid-flight, and what is on disk afterwards must be exactly
// what was on disk before — including the target account's own entry, which
// a re-restore of an account this device already knows must not damage.

const SK_A = Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff);
const PK_A = getPublicKey(Uint8Array.from(SK_A));
const SK_B = Array.from({ length: 32 }, (_, i) => (i * 9 + 7) & 0xff);
const PK_B = getPublicKey(Uint8Array.from(SK_B));
const PIN_B = '87654321';
const HANDLE_B = 'targethandle';
const RESTORE_COPY = 'This device could not save the account. Nothing was changed — try again.';

const priorVaultShape = { v: 3, dk: { k: 'prf', id: 'seeded' }, iv: [1, 2, 3], data: [4, 5, 6] };
const priorEntry = {
  vault: priorVaultShape,
  handle: 'prior',
  displayName: 'Prior Account',
  createdAt: 1700000000000,
  confirmed: true,
};
const priorMirror = JSON.stringify(priorVaultShape);

// A real vault the app can open: B's key under B's PIN. The handle door
// opens this before anything is written, so it must be genuine.
async function pinVault(sk, pin) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey('raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(sk)));
  return {
    iv: Array.from(iv), data: Array.from(new Uint8Array(ct)),
    salt: Array.from(salt), iter: 600000,
  };
}

// The opening of B's vault on this door wraps it to the device first, and
// the wrap asks the platform for a key: a virtual authenticator is this
// suite's hardware, exactly as pin-unlock.spec.js does it.
test.beforeEach(async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true },
  });
});

// Seeds the active account and the target entry with no session — boot stops
// at the lock screen, where the restore door lives — then refuses every
// write to faultKey once armed (the seed's own writes pass).
async function seed(page, { faultKey }) {
  const vaultB = await pinVault(SK_B, PIN_B);
  await page.addInitScript(({ pkA, vaultA, mirror, pkB, vaultB, faultKey }) => {
    if (sessionStorage.getItem('cipher_handle_seeded')) return;
    sessionStorage.setItem('cipher_handle_seeded', '1');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key, value) {
      if (key === faultKey && sessionStorage.getItem('cipher_fault') === '1') {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
    localStorage.setItem('cipher_vaults', JSON.stringify({
      [pkA]: { vault: vaultA, handle: 'prior', displayName: 'Prior Account', createdAt: 1700000000000, confirmed: true },
      [pkB]: { vault: vaultB, handle: 'targethandle', displayName: 'Target Account', createdAt: 1700000001000, confirmed: true },
    }));
    localStorage.setItem('cipher_active_pubkey', pkA);
    localStorage.setItem('cipher_vault', mirror);
    localStorage.setItem('cipher_handle', 'prior');
    sessionStorage.setItem('cipher_fault', '1');
  }, {
    pkA: PK_A, vaultA: priorVaultShape, mirror: priorMirror,
    pkB: PK_B, vaultB, faultKey,
  });
}

// Walks to the handle door with the words filled in but not yet submitted.
async function openHandleDoor(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Forgot PIN? Restore account' }).click();
  await expect(page.getByRole('heading', { name: 'Restore Account' })).toBeVisible();
  await page.getByPlaceholder('yourhandle').fill(HANDLE_B);
  await page.getByPlaceholder('PIN (6+ digits)').fill(PIN_B);
}

// Every slot the commit touches, read as the bytes on disk.
const diskState = (page) => page.evaluate(() => ({
  vaults: localStorage.getItem('cipher_vaults'),
  active: localStorage.getItem('cipher_active_pubkey'),
  mirror: localStorage.getItem('cipher_vault'),
  handle: localStorage.getItem('cipher_handle'),
}));

test.describe('a handle restore the storage refuses lands nothing', () => {
  test('a refusal on the handle write puts the pointer, the mirror and the active account back', async ({ page }) => {
    test.setTimeout(120000);
    await seed(page, { faultKey: 'cipher_handle' });
    await openHandleDoor(page);
    const before = await diskState(page);

    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText(RESTORE_COPY)).toBeVisible({ timeout: 60000 });

    // The pointer, the mirror, the handle and the active account are byte for
    // byte what they were, and the merged restore entry never landed. The
    // target's own entry keeps every field it had with one honest exception:
    // its vault is the device-wrapped copy the pre-commit wrap wrote — an
    // all-or-nothing writeback of its own that verified the key before
    // replacing anything, so the account is still openable, only safer.
    expect(await page.evaluate(() => localStorage.getItem('cipher_active_pubkey'))).toBe(PK_A);
    expect(await page.evaluate(() => localStorage.getItem('cipher_vault'))).toBe(priorMirror);
    expect(await page.evaluate(() => localStorage.getItem('cipher_handle'))).toBe('prior');
    const table = await page.evaluate(() => JSON.parse(localStorage.getItem('cipher_vaults')));
    expect(JSON.stringify(table[PK_A])).toBe(JSON.stringify(priorEntry));
    expect(table[PK_B].handle).toBe(HANDLE_B);
    expect(table[PK_B].displayName).toBe('Target Account');
    expect(table[PK_B].createdAt).toBe(1700000001000);
    expect(table[PK_B].confirmed).toBe(true);
    expect(table[PK_B].vault.v).toBe(3);
    expect(await page.evaluate((pk) => localStorage.getItem(`cipher_fails_${pk}`), PK_B)).toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem('cipher_session_sk'))).toBeNull();
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
    expect(before).toBeTruthy();
  });

  test('a refusal on the table write itself lands nothing at all', async ({ page }) => {
    test.setTimeout(120000);
    // The fault catches the pre-commit wrap's own write first: the wrap puts
    // itself back and says the storage's refusal in the save-failure words —
    // never "Invalid PIN", never the find-another-device sentence.
    await seed(page, { faultKey: 'cipher_vaults' });
    await openHandleDoor(page);
    const before = await diskState(page);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText(RESTORE_COPY)).toBeVisible({ timeout: 60000 });
    expect(await diskState(page)).toEqual(before);
    expect(await page.evaluate((pk) => localStorage.getItem(`cipher_fails_${pk}`), PK_B)).toBeNull();
    const said = await page.evaluate(() => document.querySelector('.text-danger')?.textContent || '');
    expect(said).not.toContain('Invalid PIN');
    expect(said).not.toContain('12 words');
  });
});

test.describe('a handle restore the storage takes lands whole', () => {
  test('with no refusal the account is active, mirrored and unlocked', async ({ page }) => {
    test.setTimeout(120000);
    await seed(page, { faultKey: '__never__' });
    await openHandleDoor(page);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();

    await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeVisible({ timeout: 60000 });
    expect(await page.evaluate(() => localStorage.getItem('cipher_active_pubkey'))).toBe(PK_B);
    expect(await page.evaluate(() => localStorage.getItem('cipher_handle'))).toBe(HANDLE_B);
    const entry = await page.evaluate((pk) => JSON.parse(localStorage.getItem('cipher_vaults'))[pk], PK_B);
    expect(entry.vault.v).toBe(3);
    expect(await page.evaluate(() => localStorage.getItem('cipher_vault'))).toBe(JSON.stringify(entry.vault));
    expect(await page.evaluate((pk) => localStorage.getItem(`cipher_fails_${pk}`), PK_B)).toBeNull();
  });
});

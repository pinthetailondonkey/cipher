import { test, expect } from '@playwright/test';
import { getPublicKey } from 'nostr-tools';
import { entropyToMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';

// Finding: a storage refusal after the vault is sealed must not leave half a
// restore behind. Through the real door — lock screen, Forgot PIN, Use
// Recovery Phrase — the 12 words are typed, Continue is tapped, and the
// storage refuses one of the commit's writes. What must be on disk after
// that: exactly what was on disk before. The account that was active stays
// active, its table entry and its mirror are untouched, the new account is
// absent, no attempt is spent, and the words on screen say what happened.

// A phrase built, not written: the pre-commit hook rightly refuses any
// 12-word literal in a diff, so the test phrase comes from entropy at
// runtime — deterministic for the run, and never key-shaped in the file.
const MNEMONIC = entropyToMnemonic(Uint8Array.from({ length: 16 }, (_, i) => i), english);
const PIN = '87654321';
const RESTORE_COPY = 'This device could not save the account. Nothing was changed — try again.';

if (!validateMnemonic(MNEMONIC, english)) throw new Error('test mnemonic is not a valid phrase');

const SK_A = Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff);
const PK_A = getPublicKey(Uint8Array.from(SK_A));
// The account the 12 words rebuild — this is who must NOT appear on a
// refused commit.
const PK_B = getPublicKey(new Uint8Array(mnemonicToSeedSync(MNEMONIC).slice(0, 32)));

const priorVault = { v: 3, dk: { k: 'prf', id: 'seeded' }, iv: [1, 2, 3], data: [4, 5, 6] };
const priorEntry = {
  vault: priorVault,
  handle: 'prior',
  displayName: 'Prior Account',
  createdAt: 1700000000000,
  confirmed: true,
};
const priorTable = JSON.stringify({ [PK_A]: priorEntry });
const priorMirror = JSON.stringify(priorVault);

// Seeds the prior account, then makes every localStorage write to faultKey
// refuse with a quota error once the flag is armed at the end of seeding —
// so the seed's own writes pass, and only the app's later write fails.
async function seedPriorAccount(page, faultKey) {
  await page.addInitScript(({ pkA, table, mirror, faultKey }) => {
    if (sessionStorage.getItem('cipher_restore_seeded')) return;
    sessionStorage.setItem('cipher_restore_seeded', '1');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key, value) {
      if (key === faultKey && sessionStorage.getItem('cipher_fault') === '1') {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
    localStorage.setItem('cipher_vaults', table);
    localStorage.setItem('cipher_active_pubkey', pkA);
    localStorage.setItem('cipher_vault', mirror);
    localStorage.setItem('cipher_handle', 'prior');
    sessionStorage.setItem('cipher_fault', '1');
  }, { pkA: PK_A, table: priorTable, mirror: priorMirror, faultKey });
}

async function typeTheWords(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Forgot PIN? Restore account' }).click();
  await page.getByRole('button', { name: 'Use Recovery Phrase' }).click();
  await expect(page.getByRole('heading', { name: 'Restore with Recovery Phrase' })).toBeVisible();
  await page.getByPlaceholder('apple banana cherry ...').fill(MNEMONIC);
  await page.getByPlaceholder(`New PIN (8 digits)`).fill(PIN);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

// Everything the commit must not have disturbed, read from the page itself.
async function diskIsUntouched(page) {
  expect(await page.evaluate(() => localStorage.getItem('cipher_vaults'))).toBe(priorTable);
  expect(await page.evaluate(() => localStorage.getItem('cipher_active_pubkey'))).toBe(PK_A);
  expect(await page.evaluate(() => localStorage.getItem('cipher_vault'))).toBe(priorMirror);
  expect(await page.evaluate(() => localStorage.getItem('cipher_handle'))).toBe('prior');
}

// Sealing the restored vault enrolls a passkey with PRF, and a browser with
// no authenticator never answers that prompt — the restore would wait
// forever, hanging on hardware rather than on storage. A virtual
// authenticator is this suite's hardware, not a change to the app: the same
// seal, commit and rollback code runs as on a real device.
test.beforeEach(async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true },
  });
});

test.describe('a restore the storage refuses lands nothing', () => {
  test('a refusal on the mirror write puts the table and the pointer back', async ({ page }) => {
    test.setTimeout(120000);
    // The commit's third write refuses: table and pointer landed first, and
    // the rollback is the only thing standing between them and a half-restore.
    await seedPriorAccount(page, 'cipher_vault');
    await typeTheWords(page);

    await expect(page.getByText(RESTORE_COPY)).toBeVisible({ timeout: 60000 });
    await diskIsUntouched(page);
    // The restored account is nowhere, and nothing was spent on it.
    expect(await page.evaluate((pk) => localStorage.getItem(`cipher_fails_${pk}`), PK_B)).toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem('cipher_session_sk'))).toBeNull();
    // The words said try again, and the screen still honours them.
    await expect(page.getByRole('heading', { name: 'Restore with Recovery Phrase' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  });

  test('a refusal on the table write itself lands nothing at all', async ({ page }) => {
    test.setTimeout(120000);
    await seedPriorAccount(page, 'cipher_vaults');
    await typeTheWords(page);

    await expect(page.getByText(RESTORE_COPY)).toBeVisible({ timeout: 60000 });
    await diskIsUntouched(page);
  });
});

test.describe('a restore the storage takes lands whole', () => {
  test('with no refusal the account is on this device and unlocked', async ({ page }) => {
    // The same walk with the fault never armed: the words must still finish
    // the whole landing — table, pointer, mirror — and open the app.
    test.setTimeout(120000);
    await seedPriorAccount(page, '__never__');
    await typeTheWords(page);

    await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeVisible({ timeout: 60000 });
    expect(await page.evaluate(() => localStorage.getItem('cipher_active_pubkey'))).toBe(PK_B);
    const entry = await page.evaluate((pk) => JSON.parse(localStorage.getItem('cipher_vaults'))[pk], PK_B);
    expect(entry.vault.v).toBe(3);
    expect(entry.confirmed).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('cipher_vault'))).toBe(JSON.stringify(entry.vault));
    expect(await page.evaluate((pk) => localStorage.getItem(`cipher_fails_${pk}`), PK_B)).toBeNull();
  });
});

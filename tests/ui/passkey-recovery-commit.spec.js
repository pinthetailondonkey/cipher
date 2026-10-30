import { test, expect } from '@playwright/test';
import { getPublicKey } from 'nostr-tools';

// Saved-passkey recovery, driven from the screen: the account loses its
// vault on this device (the state the five-PIN wipe leaves behind), the
// saved passkey record survives, and the lock screen offers recovery through
// it. A recovery whose storage write is refused must leave the record, the
// pointers and the biometric slots exactly as they were, charge no PIN
// attempt, leave no PIN-openable fallback — and after a reload the kept key
// must still open the account. Every artifact here is made by the app
// itself: the wrap at unlock, the passkey record at Backup, the recovery at
// the lock screen's passkey button.

const SK_A = Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff);
const PK_A = getPublicKey(Uint8Array.from(SK_A));
const PIN_A = '87654321';
const NEW_PIN = '24681357';
// The door's words for this refusal are the commit's own sentence: useIdentity
// tags the failure 'save-failed' and passkeyMessages.js returns that message
// instead of its generic one. The sentence lives in src/lib/vaultCommit.js:17;
// it is kept here as a literal, not imported, so this assertion can go red if
// the app's copy moves.
const PASSKEY_SAVE_FAILED = 'This device could not save the account. Nothing was changed — try again.';

// A real vault the app can open: A's key under A's PIN.
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

// The passkey record and the recovery both need the platform authenticator.
// A virtual one is this suite's hardware, exactly as pin-unlock.spec.js.
test.beforeEach(async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true },
  });
});

// Refuses every write to faultKey once armed. Armed from the next load on.
async function armFault(page, faultKey) {
  await page.addInitScript(({ faultKey }) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key, value) {
      if (key === faultKey && sessionStorage.getItem('cipher_fault') === '1') {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  }, { faultKey });
}

async function typePinOnPad(page, digits) {
  const pad = page.getByRole('group', { name: 'Number pad' });
  for (const digit of digits) await pad.getByRole('button', { name: digit, exact: true }).click();
}

const recordBytes = (page) => page.evaluate((pk) => localStorage.getItem(`cipher_passkey_${pk}`), PK_A);
const failsForA = (page) => page.evaluate((pk) => localStorage.getItem(`cipher_fails_${pk}`), PK_A);

test('a refused recovery keeps the record, the pointers and the account recoverable', async ({ page }) => {
  test.setTimeout(180000);
  // One finished account under a real PIN, no session: boot stops at the lock.
  // The one-shot guard matters more here than anywhere: the test reloads
  // after deleting this vault, and a replaying seed would quietly hand it
  // back and send the recovery down the existing-vault branch instead of the
  // new-account landing this spec exists to fault.
  await page.addInitScript(({ pk, vault }) => {
    if (sessionStorage.getItem('cipher_passkey_seeded')) return;
    sessionStorage.setItem('cipher_passkey_seeded', '1');
    localStorage.setItem('cipher_vaults', JSON.stringify({
      [pk]: { vault, handle: 'prior', displayName: 'Prior Account', createdAt: 1700000000000, confirmed: true },
    }));
    localStorage.setItem('cipher_active_pubkey', pk);
    localStorage.setItem('cipher_handle', 'prior');
  }, { pk: PK_A, vault: await pinVault(SK_A, PIN_A) });

  // Unlock for real: the right PIN opens the account and wraps it to this
  // device — the device key enrollment the record will sit beside.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeVisible({ timeout: 20000 });
  await typePinOnPad(page, PIN_A);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeVisible({ timeout: 60000 });

  // The app's own enrollment makes the record: Backup → Set up a saved
  // passkey. importPasskeyIdentityFromNsec asks the authenticator and stores
  // the record under this account's key — nothing here is fabricated.
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await page.getByText('Backup', { exact: true }).click();
  await page.getByRole('button', { name: 'Set up a saved passkey' }).click();
  await expect(page.getByText('A saved passkey opens this account on this device from now on. It does not replace the 12 words.')).toBeVisible({ timeout: 60000 });
  const record = await recordBytes(page);
  expect(record).toBeTruthy();

  // The vault is lost — the state the five-PIN wipe leaves: entry and mirror
  // gone, pointer, record and biometric slots kept, and no session (the wipe
  // happens at the lock screen, where none exists — the unlock that armed
  // this test's session is undone by hand to match). The fault is armed for
  // the loads that follow; the flag is cleared by hand before the retry.
  await page.evaluate((pk) => {
    const vaults = JSON.parse(localStorage.getItem('cipher_vaults'));
    delete vaults[pk];
    localStorage.setItem('cipher_vaults', JSON.stringify(vaults));
    localStorage.removeItem('cipher_vault');
    sessionStorage.removeItem('cipher_session_sk');
    sessionStorage.setItem('cipher_fault', '1');
  }, PK_A);
  await armFault(page, 'cipher_biometric_enabled');

  // Reload: the record alone still offers the unlock screen and its passkey
  // button. Recovery runs, the storage refuses the commit's last write, and
  // everything the commit touched comes back.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeVisible({ timeout: 20000 });
  await typePinOnPad(page, NEW_PIN);
  await page.getByRole('button', { name: 'Unlock with a saved passkey' }).click();
  await expect(page.getByRole('alert')).toContainText(PASSKEY_SAVE_FAILED, { timeout: 90000 });

  // The record is byte for byte the one the app made (the key is kept — and
  // it is the only way back into this account on this device).
  expect(await recordBytes(page)).toBe(record);
  expect(await page.evaluate(() => localStorage.getItem('cipher_biometric_pubkey'))).toBe(PK_A);
  expect(await page.evaluate(() => localStorage.getItem('cipher_biometric_enabled'))).toBe('true');
  // Nothing landed: no re-created entry, no mirror, no handle flip, and no
  // PIN-openable fallback — there is no vault at all for a PIN to open.
  expect(await page.evaluate(() => localStorage.getItem('cipher_vaults'))).toBe('{}');
  expect(await page.evaluate(() => localStorage.getItem('cipher_vault'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('cipher_handle'))).toBe('prior');
  expect(await page.evaluate(() => localStorage.getItem('cipher_active_pubkey'))).toBe(PK_A);
  // A storage refusal spends no PIN attempt.
  expect(await failsForA(page)).toBeNull();

  // Reload with the fault disarmed (sessionStorage survives a reload, so the
  // flag is cleared by hand). The kept key still opens the account: the same
  // door, the same record, and this time the storage takes it.
  await page.evaluate(() => sessionStorage.removeItem('cipher_fault'));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeVisible({ timeout: 20000 });
  await typePinOnPad(page, NEW_PIN);
  await page.getByRole('button', { name: 'Unlock with a saved passkey' }).click();
  await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeVisible({ timeout: 90000 });
  const entry = await page.evaluate((pk) => JSON.parse(localStorage.getItem('cipher_vaults'))[pk], PK_A);
  expect(entry.vault.v).toBe(3);
  expect(await page.evaluate(() => localStorage.getItem('cipher_active_pubkey'))).toBe(PK_A);
  // The record that reopened the account is still the one the app made.
  expect(await recordBytes(page)).toBe(record);
  expect(await failsForA(page)).toBeNull();
});

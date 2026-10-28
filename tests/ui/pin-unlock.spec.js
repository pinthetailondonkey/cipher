import { test, expect } from '@playwright/test';
import { getPublicKey } from 'nostr-tools';

// The lock screen against real vaults, in a real browser: what a PIN does when
// it is typed. The unit tests read the rules; these press the buttons.
//
// The fixtures are vaults built to the envelope the app itself writes
// (src/useIdentity.js encryptKey): PBKDF2-SHA256, AES-GCM, `{iv, data, salt,
// iter}`; a vault from before per-vault salts is the same minus `salt`, and
// decrypts with the fixed salt and 100k iterations at useIdentity.js:38-39.
// The app under test is what opens them, so a shape that drifts fails here.

const SK = Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const PK = getPublicKey(Uint8Array.from(SK));

async function vaultFor(pin, { legacy = false } = {}) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = legacy ? 100000 : 600000;
  const material = await crypto.subtle.importKey('raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: legacy ? enc.encode('cipher_secure_salt') : salt, iterations, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(SK)));
  const envelope = { iv: Array.from(iv), data: Array.from(new Uint8Array(ct)) };
  return legacy ? envelope : { ...envelope, salt: Array.from(salt), iter: iterations };
}

// Seeds one finished account and boots into the PIN gate.
async function seedAccount(page, { vault, handle = 'alice', extra = {} }) {
  await page.addInitScript(({ pk, vault, handle, extra }) => {
    localStorage.setItem('cipher_vaults', JSON.stringify({
      [pk]: { vault, handle, displayName: 'Alice', createdAt: 1700000000000, confirmed: true, ...extra },
    }));
    localStorage.setItem('cipher_active_pubkey', pk);
  }, { pk: PK, vault, handle, extra });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeVisible({ timeout: 15000 });
}

async function typePin(page, digits) {
  const pad = page.getByRole('group', { name: 'Number pad' });
  for (const digit of digits) await pad.getByRole('button', { name: digit, exact: true }).click();
}

async function pressUnlock(page) {
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
}

const storedFails = (page) => page.evaluate((pk) => localStorage.getItem(`cipher_fails_${pk}`), PK);
const staffedTabs = (page) => page.getByRole('navigation', { name: 'Tabs' });

test.describe('PIN unlock against real vaults', () => {
  // Device lock takes its key from the browser's passkey, so unlocking a
  // PIN-only vault asks the platform authenticator for one. Headless Chromium
  // has none: the WebAuthn prompt never answers and unlock waits forever.
  // A virtual authenticator is this test's hardware, not a change to the app —
  // the same enroll, wrap and unwrap code runs as on a real device.
  test.beforeEach(async ({ page, context }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true },
    });
  });

  test('a 6-digit PIN from before the eight-digit rule still opens the account', async ({ page }) => {
    await seedAccount(page, { vault: await vaultFor('123456') });
    await typePin(page, '123456');
    await pressUnlock(page);
    await expect(staffedTabs(page)).toBeVisible({ timeout: 20000 });
  });

  test('a 6-digit PIN in a vault from before per-vault salts opens, and the vault is upgraded', async ({ page }) => {
    const legacy = await vaultFor('123456', { legacy: true });
    expect(legacy.salt).toBeUndefined();
    await seedAccount(page, { vault: legacy });
    await typePin(page, '123456');
    await pressUnlock(page);
    await expect(staffedTabs(page)).toBeVisible({ timeout: 20000 });
    const upgraded = await page.evaluate((pk) => JSON.parse(localStorage.getItem('cipher_vaults'))[pk].vault, PK);
    // A vault that is not locked to the device is wrapped in one at unlock:
    // the entry becomes a v3 device envelope whose inner copy is the current
    // salted PIN vault built from the 12 words.
    expect(upgraded.v).toBe(3);
    expect(upgraded.dk.k).toBe('prf');
  });

  test('an eight-digit PIN opens the account', async ({ page }) => {
    await seedAccount(page, { vault: await vaultFor('87654321') });
    await typePin(page, '87654321');
    await pressUnlock(page);
    await expect(staffedTabs(page)).toBeVisible({ timeout: 20000 });
  });

  test('a ninth digit is refused, so a PIN longer than eight cannot be typed', async ({ page }) => {
    // No screen in this history ever wrote a PIN longer than eight: every PIN
    // field and this pad have capped at eight since the initial commit. The
    // cap is what makes that true, so it is the thing asserted — and the
    // consequence is shown: a 9-digit vault, were one to exist, could never be
    // opened from here, and each attempt at its 8-digit prefix would spend one
    // of the five.
    await seedAccount(page, { vault: await vaultFor('123456789') });
    const dots = page.getByRole('group', { name: 'PIN digits entered' }).locator('[data-dot]');
    await typePin(page, '123456789');
    const filled = await dots.evaluateAll((els) => els.filter((el) => el.dataset.filled === 'true').length);
    expect(filled).toBe(8);

    await pressUnlock(page);
    await expect(page.getByRole('alert')).toContainText('Wrong PIN. 4 attempts left.');
    expect(await storedFails(page)).toBe('1');
  });

  test('a 9-digit vault, were one to exist, could not be opened: the typeable prefix exhausts the five attempts', async ({ page }) => {
    test.setTimeout(180000);
    // No screen ever typed a 9-digit PIN (docs/PIN-LENGTH-EVIDENCE.md), but
    // the proof runs both ways: if such a vault existed, every PIN this
    // device can type is wrong, and the fifth press wipes the account. The
    // 12 words are then the only way back — which is why the cap that keeps
    // a 9-digit vault unwritable is load-bearing.
    //
    // The seed runs ONCE: addInitScript replays on every reload, and this
    // test ends in the wipe's own reload — a replaying seed would re-create
    // the vault the app just deleted and the assertion would test the seed,
    // not the wipe.
    const vault = await vaultFor('123456789');
    await page.addInitScript(({ pk, vault }) => {
      if (localStorage.getItem('cipher_9digit_seeded')) return;
      localStorage.setItem('cipher_9digit_seeded', '1');
      localStorage.setItem('cipher_vaults', JSON.stringify({
        [pk]: { vault, handle: 'alice', displayName: 'Alice', createdAt: 1700000000000, confirmed: true },
      }));
      localStorage.setItem('cipher_active_pubkey', pk);
    }, { pk: PK, vault });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeVisible({ timeout: 15000 });
    for (let i = 1; i <= 4; i += 1) {
      await typePin(page, '12345678');
      await pressUnlock(page);
      const left = 5 - i;
      await expect(page.getByRole('alert')).toContainText(
        left === 1 ? 'Wrong PIN. 1 attempt left.' : `Wrong PIN. ${left} attempts left.`,
      );
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeVisible({ timeout: 15000 });
    }
    // The fifth wrong press wipes the vault and reloads into create.
    await typePin(page, '12345678');
    await pressUnlock(page);
    await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeHidden({ timeout: 20000 });
    const vaults = await page.evaluate(() => localStorage.getItem('cipher_vaults'));
    expect(vaults && Object.keys(JSON.parse(vaults)).length).toBe(0);
    expect(await storedFails(page)).toBeNull();
  });

  test('a wrong PIN against a valid vault spends an attempt, and a reload spends none', async ({ page }) => {
    await seedAccount(page, { vault: await vaultFor('87654321') });
    await typePin(page, '11111111');
    await pressUnlock(page);
    await expect(page.getByRole('alert')).toContainText('Wrong PIN. 4 attempts left.');
    expect(await storedFails(page)).toBe('1');

    // Reloading is not an attempt. The counter only moves when an Unlock press
    // hands a PIN to decryption and it fails.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeVisible({ timeout: 15000 });
    expect(await storedFails(page)).toBe('1');
  });

  test('a damaged vault is not a wrong PIN: five tries do not spend the five attempts', async ({ page }) => {
    test.setTimeout(180000);
    await seedAccount(page, { vault: { iv: [1, 2, 3], data: 'not-a-byte-array' } });
    for (let i = 0; i < 5; i += 1) {
      await typePin(page, '87654321');
      await pressUnlock(page);
      await expect(page.getByRole('alert')).toContainText('damaged copy');
      // A reload between rounds doubles as the "reload is not an attempt"
      // check, and clears the dot row without waiting on a disabled key.
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeVisible({ timeout: 15000 });
    }
    expect(await storedFails(page)).toBeNull();
    const entry = await page.evaluate((pk) => JSON.parse(localStorage.getItem('cipher_vaults'))[pk], PK);
    expect(entry?.vault).toEqual({ iv: [1, 2, 3], data: 'not-a-byte-array' });
  });

  test('a missing vault answers on its own and spends no attempt', async ({ page }) => {
    await seedAccount(page, { vault: await vaultFor('87654321') });
    await page.evaluate(() => {
      localStorage.removeItem('cipher_vaults');
      localStorage.removeItem('cipher_vault');
      localStorage.removeItem('cipher_active_pubkey');
    });
    await typePin(page, '87654321');
    await pressUnlock(page);
    await expect(page.getByRole('alert')).toContainText('No local vault found');
    expect(await storedFails(page)).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('cipher_fails_legacy'))).toBeNull();
  });

  test('a vault whose iv and data are whole but whose salt is damaged still counts as a wrong PIN', async ({ page }) => {
    // The honest edge the damaged-vault guard cannot see: the envelope has iv
    // and data, so it is handed to decryption, and the KDF fails on the salt.
    // GCM cannot tell that apart from a wrong PIN, so it spends one. Recorded
    // here as a measurement, not as a promise.
    const vault = await vaultFor('87654321');
    vault.salt = [1, 2, 3];
    await seedAccount(page, { vault });
    await typePin(page, '87654321');
    await pressUnlock(page);
    await expect(page.getByRole('alert')).toContainText('Wrong PIN. 4 attempts left.');
    expect(await storedFails(page)).toBe('1');
  });

  test('salt metadata of the wrong shape is a damaged copy, not a wrong PIN', async ({ page }) => {
    // A non-array salt fails PBKDF2 before any PIN is tried. Before the
    // guard grew eyes for metadata, this charged one of the five attempts
    // against a copy no PIN could ever open.
    const vault = await vaultFor('87654321');
    vault.salt = 'sixteen-bytes';
    await seedAccount(page, { vault });
    await typePin(page, '87654321');
    await pressUnlock(page);
    await expect(page.getByRole('alert')).toContainText('damaged copy');
    expect(await storedFails(page)).toBeNull();
  });

  test('iter metadata of the wrong shape is a damaged copy, not a wrong PIN', async ({ page }) => {
    const vault = await vaultFor('87654321');
    vault.iter = 'lots';
    await seedAccount(page, { vault });
    await typePin(page, '87654321');
    await pressUnlock(page);
    await expect(page.getByRole('alert')).toContainText('damaged copy');
    expect(await storedFails(page)).toBeNull();
  });
});

test.describe('Restore by handle keeps what the entry already held', () => {
  // A restore wraps the local vault in a device key, so it asks the platform
  // authenticator for one exactly as unlock does. Headless Chromium has none,
  // and the request never answers — the same reason the unlock suite above
  // installs the virtual authenticator. This is the test's hardware, not a
  // change to the app: the same enroll, wrap and unwrap code runs.
  test.beforeEach(async ({ page, context }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true },
    });
  });

  test('the encrypted 12 words and the entry metadata survive a local restore', async ({ page }) => {
    test.setTimeout(120000);
    const mnemonicEnc = { iv: [9, 9, 9], ct: [7, 7, 7] };
    await seedAccount(page, {
      vault: await vaultFor('87654321'),
      handle: 'alice',
      // A device envelope is no longer a field on the entry: the vault itself
      // is the device envelope (v3) once it has been wrapped.
      extra: { mnemonicEnc },
    });

    await page.getByRole('button', { name: 'Forgot PIN? Restore account' }).click();
    await page.getByPlaceholder('yourhandle').fill('alice');
    await page.getByPlaceholder('PIN (6+ digits)').fill('87654321');
    // The screen holds the button while it asks this device whether it can
    // keep a key; pressing before that answer lands is a no-op.
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: 15000 });
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(staffedTabs(page)).toBeVisible({ timeout: 120000 });
    const entry = await page.evaluate((pk) => JSON.parse(localStorage.getItem('cipher_vaults'))[pk], PK);
    expect(entry.mnemonicEnc).toEqual(mnemonicEnc);
    // The vault on disk is a v3 device envelope now, and it still opens.
    expect(entry.vault.v).toBe(3);
    expect(entry.handle).toBe('alice');
    expect(entry.displayName).toBe('Alice');
    expect(entry.createdAt).toBe(1700000000000);
    expect(entry.confirmed).toBe(true);
  });

  test('a damaged vault found by handle answers damaged, not wrong PIN', async ({ page }) => {
    // The relay path charges attempts exactly like unlock, so it needs the
    // same damaged-copy answer: no PIN could open this shape, and none of
    // the five attempts may be spent finding that out.
    const vault = await vaultFor('87654321');
    vault.salt = 'sixteen-bytes';
    await seedAccount(page, { vault, handle: 'alice' });
    await page.getByRole('button', { name: 'Forgot PIN? Restore account' }).click();
    await page.getByPlaceholder('yourhandle').fill('alice');
    await page.getByPlaceholder('PIN (6+ digits)').fill('87654321');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText(/damaged copy/)).toBeVisible({ timeout: 10000 });
    expect(await storedFails(page)).toBeNull();
  });
});

test.describe('The saved-passkey door on the restore screen', () => {
  test('the door follows WebAuthn presence, not whether an authenticator can answer', async ({ page }) => {
    // Measured limit of the fix: the screen asks nostr-passkey's
    // isPRFSupported(), which is only "this browser has WebAuthn"
    // (dist/chunk-ZKAH7U4Z.js:129) — no authenticator is consulted. This
    // headless browser has WebAuthn and no platform authenticator at all, and
    // the door is still offered. Recorded as a finding, not a pass.
    await page.addInitScript(({ pk }) => {
      localStorage.setItem('cipher_passkey_' + pk, JSON.stringify({ pubkey: pk }));
      localStorage.setItem('cipher_active_pubkey', pk);
      localStorage.setItem('cipher_vault', JSON.stringify({ iv: [1], data: [2] }));
    }, { pk: PK });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Forgot PIN? Restore account' }).click();

    const platformAuthenticator = (await page.evaluate(async () => {
      try {
        return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      } catch { return false; }
    }));
    // Founder's call, 2026-10-28: keep the saved-passkey path. The door is
    // shown on a stored record and a WebAuthn presence check, with no
    // authenticator prompt spent on deciding to show it, and its words name
    // a saved passkey rather than one vendor's face unlock.
    const door = page.getByRole('button', { name: /Use saved passkey/ });
    await expect(door).toHaveCount(1);
    expect(platformAuthenticator).toBe(false);
  });

  test("a refusal the browser words in spec-speak surfaces as one plain sentence", async ({ page }) => {
    // Executes the whole plain-words wire in a real browser: a valid v2
    // record the library will actually try, an authenticator that answers
    // with Chrome's measured refusal, and a screen that must answer with
    // the cancelled sentence — never the DOMException's name, wording, or
    // spec URL — with the recovery door still standing beside it.
    // (Learned the hard way: a bare {pubkey} stub is refused as 'no
    // identity' before the browser is ever asked, so the record must be
    // the full v2 shape measured reaching credentials.get.)
    await page.addInitScript(({ pk, record }) => {
      localStorage.setItem('cipher_passkey_' + pk, record);
      localStorage.setItem('cipher_active_pubkey', pk);
      localStorage.setItem('cipher_vault', JSON.stringify({ iv: [1], data: [2] }));
      navigator.credentials.get = async () => {
        throw Object.assign(
          new Error('The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sec-assertion-privacy'),
          { name: 'NotAllowedError' },
        );
      };
    }, {
      pk: PK,
      record: JSON.stringify({
        version: 2,
        credentialId: Buffer.from('credential').toString('base64'),
        encryptedNsec: Buffer.from('payload').toString('base64'),
        pubkey: PK,
        salt: Buffer.from('salt').toString('base64'),
        rpId: 'ciphermessenger.org',
      }),
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Forgot PIN? Restore account' }).click();

    await page.getByRole('button', { name: /Use saved passkey/ }).click();
    const said = page.locator('p.text-danger');
    await expect(said).toContainText('Passkey cancelled. Enter your PIN, or use your recovery phrase.', { timeout: 10000 });
    // The browser's own phrasing never reaches the screen.
    await expect(said).not.toContainText('NotAllowedError');
    await expect(said).not.toContainText('timed out');
    await expect(said).not.toContainText('https://');
    // And the way back is still standing next to the failure.
    await expect(page.getByRole('button', { name: 'Use Recovery Phrase' })).toBeVisible();
  });
});

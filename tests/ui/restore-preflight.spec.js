import { test, expect } from '@playwright/test';

// The recovery-phrase screen asks the device whether it can hold a key
// before it asks for the words. Three states: still checking, ready, cannot.
// What this asserts on each: the words field and the PIN field are closed
// until the device says yes, the sentence on screen matches the state, and
// rendering asks no authentication anywhere — the preflight reads the
// environment, it never raises a prompt. Presence of WebAuthn is all it
// reads; an external security key is never excluded (no exclusion list is
// sent, grep-verified in src/ and nostr-passkey's dist).

const PENDING_COPY = 'Checking this device can keep a key…';
const UNAVAILABLE_COPY = 'This device cannot lock an account to itself.';

// Counts every authentication attempt the page makes, and makes any attempt
// loud: a render path that authenticates fails here, not silently somewhere.
async function countAuthAttempts(page) {
  await page.addInitScript(() => {
    window.__authAttempts = { create: 0, get: 0 };
    if (navigator.credentials) {
      const { create, get } = navigator.credentials;
      navigator.credentials.create = (...args) => { window.__authAttempts.create += 1; return create.apply(navigator.credentials, args); };
      navigator.credentials.get = (...args) => { window.__authAttempts.get += 1; return get.apply(navigator.credentials, args); };
    }
  });
}

async function openRestoreMnemonic(page) {
  // One finished account on the device puts boot on the lock screen, where
  // the recovery-phrase door lives.
  await page.addInitScript(() => {
    localStorage.setItem('cipher_vaults', JSON.stringify({
      deadbeef: { vault: { v: 3, dk: { k: 'prf', id: 'x' }, iv: [1], data: [2] }, handle: 'prior', displayName: 'Prior', createdAt: 1, confirmed: true },
    }));
    localStorage.setItem('cipher_active_pubkey', 'deadbeef');
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Unlock Cipher' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Forgot PIN? Restore account' }).click();
  await page.getByRole('button', { name: 'Use Recovery Phrase' }).click();
  await expect(page.getByRole('heading', { name: 'Restore with Recovery Phrase' })).toBeVisible();
}

const wordsField = (page) => page.getByPlaceholder('apple banana cherry ...');
const pinField = (page) => page.getByPlaceholder('New PIN (8 digits)');
const continueButton = (page) => page.getByRole('button', { name: 'Continue', exact: true });
const authAttempts = (page) => page.evaluate(() => window.__authAttempts || { create: 0, get: 0 });

test.describe('while the device check is pending', () => {
  test('the fields stay closed and nothing authenticates', async ({ page }) => {
    // A desktop bridge that never answers — the check hangs, and the screen
    // must sit closed rather than guess. The optimistic old default was
    // `true`: a hung or rejected check left the words field open.
    await countAuthAttempts(page);
    await page.addInitScript(() => {
      window.cipherDeviceKey = { available: () => new Promise(() => {}) };
    });
    await openRestoreMnemonic(page);

    await expect(page.getByText(PENDING_COPY)).toBeVisible({ timeout: 15000 });
    await expect(wordsField(page)).toBeDisabled();
    await expect(pinField(page)).toBeDisabled();
    await expect(continueButton(page)).toBeDisabled();
    // The hang is not resolved by waiting longer — the state is the answer.
    await page.waitForTimeout(3000);
    await expect(wordsField(page)).toBeDisabled();
    expect(await authAttempts(page)).toEqual({ create: 0, get: 0 });
  });
});

test.describe('when no provider can hold a key', () => {
  test('the screen says so, stays closed, and charges no prompt', async ({ page }) => {
    // A bridge that refuses, and a browser with no WebAuthn at all: both
    // providers answer no. The old code swallowed a rejection and left the
    // gate open; the explicit catch must close it.
    await countAuthAttempts(page);
    await page.addInitScript(() => {
      window.cipherDeviceKey = { available: () => Promise.reject(new Error('no bridge')) };
      delete window.PublicKeyCredential;
    });
    await openRestoreMnemonic(page);

    await expect(page.getByText(UNAVAILABLE_COPY, { exact: false })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(PENDING_COPY)).toBeHidden();
    await expect(wordsField(page)).toBeDisabled();
    await expect(pinField(page)).toBeDisabled();
    await expect(continueButton(page)).toBeDisabled();
    expect(await authAttempts(page)).toEqual({ create: 0, get: 0 });
  });
});

test.describe('when the device answers yes', () => {
  test('the fields open and no authentication was raised to show them', async ({ page }) => {
    // WebAuthn present is enough to say yes — the check reads presence, it
    // does not prove PRF works by authenticating. No bridge, no authenticator
    // attached: the button still renders usable, because usable here means
    // the environment check passed, not that a prompt was answered.
    await countAuthAttempts(page);
    await openRestoreMnemonic(page);

    await expect(page.getByText(PENDING_COPY)).toBeHidden({ timeout: 15000 });
    await expect(wordsField(page)).toBeEnabled();
    await expect(pinField(page)).toBeEnabled();
    await expect(continueButton(page)).toBeEnabled();
    expect(await authAttempts(page)).toEqual({ create: 0, get: 0 });
  });
});

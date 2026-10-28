import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';

// The browser device key, driven by Chromium's virtual authenticator with the
// PRF extension. This is the real devicePrf provider and the real vault code,
// bundled into a page served from http://localhost (a valid WebAuthn origin;
// 127.0.0.1 is not). What it proves: the secret lives under the authenticator,
// a copy of the page's storage without that authenticator cannot open the
// vault, and a wrong PIN is told apart from a missing authenticator.
// It does not prove anything about Safari, Firefox, Android or real hardware.

const ORIGIN = 'http://localhost:4173';
const PK = 'c'.repeat(64);
const SK = Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256);

let bundle = '';

test.beforeAll(async () => {
  const entry = fileURLToPath(new URL('./support/deviceLockHarness.js', import.meta.url));
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      write: false,
      minify: false,
      lib: { entry, name: 'DeviceLockHarness', formats: ['iife'], fileName: 'h' },
    },
  });
  const result = Array.isArray(out) ? out[0] : out;
  bundle = result.output[0].code;
});

async function openPage(context, { authenticator = true } = {}) {
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>t</title><body></body>' }));
  await page.goto(`${ORIGIN}/`);
  let cdp = null;
  if (authenticator) {
    cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true },
    });
  }
  await page.addScriptTag({ content: bundle });
  return { page, cdp };
}

test('enroll, seal, reload, open: the passkey opens the vault, and the secret is never stored in the clear', async ({ browser }) => {
  const context = await browser.newContext();
  const { page } = await openPage(context);
  const sealed = await page.evaluate(([pk, sk]) => window.H.enrollAndSeal(pk, '12345678', sk), [PK, SK]);
  expect(sealed.ok).toBe(true);
  expect(sealed.vault.v).toBe(3);
  expect(sealed.vault.dk.k).toBe('prf');

  const stored = await page.evaluate((pk) => localStorage.getItem(`cipher_devkey_${pk}`), PK);
  expect(stored).toBeTruthy();
  const record = JSON.parse(stored);
  expect(record.version).toBe(2);
  // Only the PRF-encrypted copy is stored; the wrapped secret is not hex of itself.
  expect(record.encryptedNsec).not.toMatch(/^[0-9a-f]{64}$/);

  const opened = await page.evaluate(([pk, vault]) => window.H.open(pk, '12345678', vault), [PK, sealed.vault]);
  expect(opened).toEqual({ ok: true, sk: SK });

  // Same storage, page reloaded, in-memory secret gone: the authenticator is asked again.
  await page.reload();
  await page.addScriptTag({ content: bundle });
  const reopened = await page.evaluate(([pk, vault]) => window.H.open(pk, '12345678', vault), [PK, sealed.vault]);
  expect(reopened).toEqual({ ok: true, sk: SK });
  await context.close();
});

test('right authenticator, wrong PIN fails as a plain crypto error, not a device key error', async ({ browser }) => {
  const context = await browser.newContext();
  const { page } = await openPage(context);
  const sealed = await page.evaluate(([pk, sk]) => window.H.enrollAndSeal(pk, '12345678', sk), [PK, SK]);
  const wrong = await page.evaluate(([pk, vault]) => window.H.open(pk, '00000000', vault), [PK, sealed.vault]);
  expect(wrong.ok).toBe(false);
  expect(wrong.error.name).not.toMatch(/^DeviceKey/);
  await context.close();
});

test('a copy of the page storage on a device without the authenticator cannot open the vault', async ({ browser }) => {
  const original = await browser.newContext();
  const first = await openPage(original);
  const sealed = await first.page.evaluate(([pk, sk]) => window.H.enrollAndSeal(pk, '12345678', sk), [PK, SK]);
  const copiedRecord = await first.page.evaluate((pk) => localStorage.getItem(`cipher_devkey_${pk}`), PK);
  await original.close();

  // A different browser profile with a fresh authenticator that holds no credentials.
  const thief = await browser.newContext();
  const second = await openPage(thief);
  await second.page.evaluate(([pk, record]) => localStorage.setItem(`cipher_devkey_${pk}`, record), [PK, copiedRecord]);
  const attempt = await second.page.evaluate(([pk, vault]) => window.H.open(pk, '12345678', vault), [PK, sealed.vault]);
  expect(attempt.ok).toBe(false);
  expect(attempt.error.name).toMatch(/^DeviceKey(Cancelled|Missing)$/);
  await thief.close();

});

test('with the stored record removed the vault reports a missing device key', async ({ browser }) => {
  const context = await browser.newContext();
  const { page } = await openPage(context);
  const sealed = await page.evaluate(([pk, sk]) => window.H.enrollAndSeal(pk, '12345678', sk), [PK, SK]);
  await page.evaluate((pk) => window.H.destroy(pk), PK);
  expect(await page.evaluate((pk) => window.H.has(pk), PK)).toBe(false);
  const gone = await page.evaluate(([pk, vault]) => window.H.open(pk, '12345678', vault), [PK, sealed.vault]);
  expect(gone.ok).toBe(false);
  expect(gone.error.name).toBe('DeviceKeyMissing');
  await context.close();
});

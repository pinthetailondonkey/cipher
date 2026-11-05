import { getPublicKey } from 'nostr-tools';

// Seeds the account the browser specs boot into.
//
// Boot no longer restores a session. The raw secret lives in memory for the
// tab's lifetime (src/lib/sessionKey.js), so a fresh page carries no key and
// the vault's own door is the only way back in: seed a real vault, then let
// the PIN gate open it. Seeding a sessionStorage key without a vault is what
// this file used to do, and against today's boot that is nothing at all.
//
// Two consequences shaped the shape below.
//
// The seed is a literal, not derived. `page.addInitScript(fn)` serializes the
// function without its module scope, so nothing outside can be reached from
// inside it, and a seed that first has to await PBKDF2 (the app derives at
// 600k iterations) races the app's own first read of localStorage. A vault
// generated once and pasted in is written synchronously, before any page
// script runs. The generator is the app's own recipe (src/useIdentity.js
// encryptKey: PBKDF2-SHA256 600k, AES-GCM, `{iv, data, salt, iter}`), and
// pin-unlock.spec.js builds the same envelope by the same recipe, so a drift
// in that shape fails there loudly rather than here quietly.
//
// The unlock is explicit and tolerant. Explicit, because the gate is a real
// gate now and a spec that walks through it exercises the door it ships.
// Tolerant, because a build that still restores a session boots straight past
// the gate: `unlock(page)` there answers false and costs nothing, so these
// specs run green on either boot while the change lands.

export const TEST_PIN = '13572468';
export const TEST_SK = Array.from({ length: 32 }, () => 170);
// The account the seeds belong to. Written out again inside seedVault, which
// cannot see this binding; the check below keeps the two copies honest.
const SEED_PK = '6a04ab98d9e4774ad806e302dddeb63bea16b5cb5f223ee77478e861bb583eb3';
export const TEST_PK = getPublicKey(Uint8Array.from(TEST_SK));

if (TEST_PK !== SEED_PK) {
  throw new Error(`tests/ui/fixtures.js: the seed pubkey literal drifted from TEST_SK (${TEST_PK})`);
}

// TEST_SK under TEST_PIN, salt and iv fixed so the seed is reproducible.
const TEST_VAULT = {
  iv: [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9],
  data: [
    56, 108, 159, 162, 242, 170, 40, 216, 48, 147, 149, 203, 219, 204, 147, 140, 188, 67, 5, 17,
    93, 143, 72, 46, 84, 123, 160, 117, 238, 219, 249, 185, 1, 122, 216, 244, 235, 39, 75, 76,
    133, 241, 83, 151, 149, 240, 56, 250, 132, 120, 46, 103, 219, 123, 189, 133, 238, 168, 203,
    102, 46, 68, 72, 11, 242, 112, 152, 105, 90, 124, 17, 107, 73, 108, 152, 172, 55, 87, 99, 64,
    204, 219, 43, 147, 219, 6, 36, 16, 27, 45, 17, 96, 145, 110, 48, 163, 174, 68, 132, 9, 118,
    172, 219, 101, 49, 246, 214, 26, 120, 100, 162, 117, 75, 117, 42, 181, 16, 144, 24, 249, 144,
    104, 21, 224, 249, 180, 212, 45, 165, 105, 99, 51, 30, 166, 203, 203, 235, 250, 47, 89, 196,
    205, 42, 16, 129,
  ],
  salt: [7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7],
  iter: 600000,
};

// Runs before every navigation. A finished account, one vault, no draft.
//
// `once` seeds only the first navigation of the page, so a reload keeps
// whatever the app itself wrote in place (an unlock wraps the vault, and a
// spec about the wrapped vault wants it kept). Off by default: the specs that
// reload mid-test want the seed replayed, not the app's own leftovers.
export function seedVault({ once = false } = {}) {
  const pk = '6a04ab98d9e4774ad806e302dddeb63bea16b5cb5f223ee77478e861bb583eb3';
  if (once) {
    if (localStorage.getItem('cipher_fixture_seeded')) return;
    localStorage.setItem('cipher_fixture_seeded', '1');
  }
  localStorage.setItem('cipher_vaults', JSON.stringify({
    [pk]: {
      vault: {
        iv: [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9],
        data: [
          56, 108, 159, 162, 242, 170, 40, 216, 48, 147, 149, 203, 219, 204, 147, 140, 188, 67, 5,
          17, 93, 143, 72, 46, 84, 123, 160, 117, 238, 219, 249, 185, 1, 122, 216, 244, 235, 39,
          75, 76, 133, 241, 83, 151, 149, 240, 56, 250, 132, 120, 46, 103, 219, 123, 189, 133, 238,
          168, 203, 102, 46, 68, 72, 11, 242, 112, 152, 105, 90, 124, 17, 107, 73, 108, 152, 172,
          55, 87, 99, 64, 204, 219, 43, 147, 219, 6, 36, 16, 27, 45, 17, 96, 145, 110, 48, 163,
          174, 68, 132, 9, 118, 172, 219, 101, 49, 246, 214, 26, 120, 100, 162, 117, 75, 117, 42,
          181, 16, 144, 24, 249, 144, 104, 21, 224, 249, 180, 212, 45, 165, 105, 99, 51, 30, 166,
          203, 203, 235, 250, 47, 89, 196, 205, 42, 16, 129,
        ],
        salt: [7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7],
        iter: 600000,
      },
      handle: 'satoshi',
      displayName: 'Satoshi',
      createdAt: 1700000000000,
      confirmed: true,
    },
  }));
  localStorage.setItem('cipher_active_pubkey', pk);
  // The gate's own memory of wrong PINs: a seeded account starts unpunished.
  localStorage.removeItem(`cipher_fails_${pk}`);
}

// The virtual authenticator is the browser's hardware: the device layer takes
// its key from a passkey, so a vault that is not wrapped yet gets wrapped at
// the unlock, and headless Chromium with no authenticator leaves that WebAuthn
// call waiting forever. Same enroll/wrap code as a real device.
async function installVirtualPasskey(page) {
  const context = page.context();
  if (context.cipherVirtualPasskey) return;
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true,
    },
  });
  context.cipherVirtualPasskey = true;
}

const gateHeading = (page) => page.getByRole('heading', { name: 'Unlock Cipher' });
const tabBar = (page) => page.getByRole('navigation', { name: 'Tabs' });

// Opens the seeded account. Call it after a goto, on every page that seeds.
// Answers true when it walked a PIN gate, false when the build had already
// booted past one.
export async function unlock(page, pin = TEST_PIN) {
  await installVirtualPasskey(page);
  // Whichever arrives first settles it: the gate (nothing restored, as today's
  // boot does) or the tab bar (a build that restores a session for itself).
  const gateFirst = await Promise.race([
    gateHeading(page).waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false),
    tabBar(page).waitFor({ state: 'visible', timeout: 15000 }).then(() => false, () => false),
  ]);
  if (!gateFirst) return false;

  const pad = page.getByRole('group', { name: 'Number pad' });
  for (const digit of pin) {
    const key = pad.getByRole('button', { name: digit, exact: true });
    if (!await key.click({ timeout: 5000 }).then(() => true, () => false)) return false;
  }
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();

  const opened = await gateHeading(page)
    .waitFor({ state: 'hidden', timeout: 30000 })
    .then(() => true, () => false);
  if (!opened) {
    throw new Error('tests/ui/fixtures.js: the PIN gate did not open (wrong PIN, lockout, or no virtual passkey)');
  }
  return true;
}

// The common pair: seed, land, open. A spec that needs its own goto keeps
// calling seedVault and unlock itself.
export async function boot(page, path = '/') {
  await page.addInitScript(seedVault);
  await page.goto(path);
  await unlock(page);
}

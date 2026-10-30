import { test, expect } from '@playwright/test';
import { getPublicKey } from 'nostr-tools';

// What a UI-test build may reach. The build the walks run against is the
// shipping build plus the test seam, so its rows resolve to the production
// hosts unless the build itself says otherwise. A walk that opens those hosts
// puts this machine in front of them for no reason a test needs.
//
// This spec dials nothing. Every websocket is intercepted and closed before it
// connects, and every request that is not this machine's is aborted, so the
// thing under test is the address the app *would* dial, recorded without
// reaching it.
//
// A failure here prints a count and not a hostname: the finding is "the walk
// left this machine", and naming where it went is the leak, not the evidence.

const SK = Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff);
const PK = getPublicKey(Uint8Array.from(SK));

const isLocal = (host) => host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';

// A finished account with a live session, so boot gets past the lock and does
// the work it normally does: profile, relays, chats. A first-run page would
// prove nothing, because it dials nothing.
const deviceShapedVault = () => ({ v: 3, dk: { k: 'prf', id: 'seeded' }, iv: [1, 2, 3], data: [4, 5, 6] });

async function seedSession(page) {
  await page.addInitScript(({ pk, vault, sk }) => {
    sessionStorage.setItem('cipher_session_seeded', '1');
    sessionStorage.setItem('cipher_session_sk', JSON.stringify(sk));
    localStorage.setItem('cipher_vaults', JSON.stringify({
      [pk]: { vault, handle: 'alice', displayName: 'Alice', createdAt: 1700000000000, confirmed: true },
    }));
    localStorage.setItem('cipher_active_pubkey', pk);
  }, { pk: PK, vault: deviceShapedVault(), sk: SK });
}

test('a UI-test build reaches nothing but this machine', async ({ page }) => {
  const foreign = new Set();

  await page.routeWebSocket(() => true, (ws) => {
    try {
      const { hostname } = new URL(ws.url());
      if (!isLocal(hostname)) foreign.add(`ws:${hostname}`);
    } catch { /* an address that will not parse is not this machine either */ }
    ws.close();
  });

  await page.route('**/*', (route) => {
    let url;
    try { url = new URL(route.request().url()); } catch { return route.continue(); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return route.continue();
    if (isLocal(url.hostname)) return route.continue();
    foreign.add(`http:${url.hostname}`);
    return route.abort();
  });

  await seedSession(page);
  await page.goto('/');
  // Boot decides what to dial; an account takes a moment to get there.
  await page.waitForTimeout(5000);

  expect(
    foreign.size,
    `boot dialled ${foreign.size} address(es) that are not this machine. Names are withheld: the finding is that the walk left this machine, and the name of where it went is the leak.`,
  ).toBe(0);
});

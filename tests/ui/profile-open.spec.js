import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

// The blank-profile bug: tapping a user's or vendor's profile showed
// nothing at all. The lazy boundary that draws the profile card fell back
// to null, so while the chunk was in flight the tap had zero visible
// answer, and a chunk that failed to arrive threw to the root error
// boundary and replaced the whole app. This file pins the fix from the
// outside, through the chat header's own Profile door: the tap must put
// something on screen — the card, or the spinner that stands in — and the
// card must arrive as a dialog named by the peer's name, or the short npub
// when no name is held. Synthetic peer, no relay.

const PEER = 'e'.repeat(64);

test.describe('opening a profile from the chat header', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(seedVault);
    await page.goto('/');
    // The app boots past the lock screen into the shell; one reload guards
    // against a cold boot that paints nothing (session restore races).
    const shellButton = page.getByRole('button', { name: 'Chat list menu' }).first();
    await expect(shellButton).toBeVisible({ timeout: 15000 }).catch(async () => {
      await page.reload();
      await expect(shellButton).toBeVisible({ timeout: 15000 });
    });
  });

  test('the Profile tap answers on screen and the card names the peer', async ({ page }) => {
    // The boot's history fetch is allowed to land first, so the seed written
    // after this point is not replaced by the relay's empty copy.
    await page.waitForTimeout(2000);
    await page.evaluate(async ({ peer }) => {
      const store = window.__cipherStore;
      if (!store) throw new Error('window.__cipherStore missing — the UI-test seam did not load');
      const now = Math.floor(Date.now() / 1000);
      const row = { id: 'dm-hello', pubkey: peer, timestamp: now - 900, isSender: false, data: { message: 'hello' } };
      await window.__cipher.saveMessage(peer, { ...row, isGroup: false, chatId: peer });
      store.setState({
        profiles: { [peer]: { displayName: 'Ada', name: 'ada' } },
        dms: { [peer]: [row] },
      });
    }, { peer: PEER });

    // Open the thread; the options kebab is the thread-open witness.
    await page.getByRole('button', { name: 'Ada' }).click();
    await expect(page.getByRole('button', { name: 'Chat options' })).toBeVisible({ timeout: 10000 });

    // The tap under test: the DM header's own Profile door.
    await page.getByRole('button', { name: 'Profile', exact: true }).click();

    // Any dialog stands for the card; the spinner stands in while the card's
    // chunk is in flight.
    const anyDialog = page.getByRole('dialog').first();
    const loading = page.getByRole('status', { name: 'Opening…' });

    // (a) The tap answers with something visible rather than nothing: the
    // card itself, or the spinner that now stands in for it.
    await expect
      .poll(async () => (await anyDialog.isVisible()) || (await loading.isVisible()), { timeout: 5000 })
      .toBeTruthy();

    // (b) The card lands carrying the peer's name. The name is asserted as
    // the display name the store already holds, NOT a name-or-npub pair:
    // before the fix the card opened nameless and fell back to the short
    // npub, and an alternation would let that pass. The pre-fix tree must go
    // red HERE, on the missing name.
    const card = page.getByRole('dialog', { name: 'Ada' });
    await expect(card).toBeVisible({ timeout: 10000 });

    // A chunk that fails to arrive used to throw to the root error boundary
    // and take the whole app with it; the crash screen must stay away.
    await expect(page.getByRole('heading', { name: 'Something went wrong', exact: true })).toHaveCount(0);
  });
});

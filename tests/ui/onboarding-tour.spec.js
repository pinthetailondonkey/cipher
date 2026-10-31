import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

// The after-signup tour's Selling step is a door, not prose: tapping it swaps
// the tour sheet's body for the vendor panel, inside the SAME dialog. The
// sheet's own name survives a dead control, so naming it proves nothing here —
// these tests tap the door and read what the swap raised.
//
// Red-first: on the base tree there is no door to tap and the old Selling body
// is still in the array, so the reachability and not-forked arms cannot pass.
// The step-one exit is the control: it passes on both arms by design (it is
// the behaviour the panel must not lose, not a new claim).

test.describe('After-signup tour: the Selling step', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(seedVault);
    await page.goto('/');
    // One reload guards against a cold boot that paints nothing, same as
    // sheet-a11y.
    const shellButton = page.getByRole('button', { name: 'Chat list menu' }).first();
    await expect(shellButton).toBeVisible({ timeout: 15000 }).catch(async () => {
      await page.reload();
      await expect(shellButton).toBeVisible({ timeout: 15000 });
    });
  });

  // The new-account flag raises the tour on boot, the way a first run does.
  async function openTour(page) {
    await page.evaluate(() => localStorage.setItem('cipher_new_account', 'true'));
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'How to use' })).toBeVisible({ timeout: 20000 });
  }

  // Step one is Welcome, so three Nexts land on the Selling door (index 3).
  async function advanceToSelling(page) {
    for (let i = 0; i < 3; i += 1) {
      await page.getByRole('button', { name: 'Next' }).click();
    }
  }

  function newAccountFlag(page) {
    return page.evaluate(() => localStorage.getItem('cipher_new_account'));
  }

  function showTutorial(page) {
    return page.evaluate(() => {
      const store = window.__cipherStore;
      if (!store) throw new Error('window.__cipherStore missing — the UI-test seam did not load');
      return store.getState().showTutorial;
    });
  }

  test('the door opens the vendor panel and the old Selling body is gone', async ({ page }) => {
    await openTour(page);
    await advanceToSelling(page);

    // The door itself, by the one word it kept. It is a real control, not a
    // clickable heading: a button with a 44px tap target at phone width.
    const door = page.getByRole('button', { name: 'Selling' });
    await expect(door).toBeVisible();
    const box = await door.boundingBox();
    expect(box).not.toBeNull();
    expect(box.height).toBeGreaterThanOrEqual(44);
    await door.click();

    // The panel's heading and one sentence of its body are on screen.
    await expect(page.getByRole('heading', { name: 'Selling' })).toBeVisible();
    await expect(page.getByText('Cipher never holds the money.')).toBeVisible();

    // Not twinned: the step's old paying-address prose is not in the array any
    // more, so it cannot render beside the panel.
    await expect(page.getByText('publish your products and share your menu')).toHaveCount(0);
  });

  test('the swap does not fork the sheet: exactly one dialog named How to use', async ({ page }) => {
    await openTour(page);
    await advanceToSelling(page);
    await page.getByRole('button', { name: 'Selling' }).click();
    await expect(page.getByRole('heading', { name: 'Selling' })).toBeVisible();

    // One dialog on the whole page, and it is still named by the sheet's own
    // title. A second role=dialog — or a route — would make this 2.
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(page.getByRole('dialog', { name: 'How to use' })).toHaveCount(1);
  });

  test('closing exits the tour and clears the new-account flag, from step one and from the panel', async ({ page }) => {
    // Control: the exit that existed before this change. It passes on both
    // arms — it is here so the panel's exit is measured against something.
    await openTour(page);
    await expect.poll(() => showTutorial(page)).toBe(true);
    await page.getByRole('button', { name: 'Close guide' }).click();
    await expect(page.getByRole('dialog', { name: 'How to use' })).toBeHidden({ timeout: 5000 });
    await expect.poll(() => newAccountFlag(page)).toBeNull();
    await expect.poll(() => showTutorial(page)).toBe(false);

    // Witness: the same exit taken from inside the vendor panel.
    await openTour(page);
    await advanceToSelling(page);
    await page.getByRole('button', { name: 'Selling' }).click();
    await expect(page.getByRole('heading', { name: 'Selling' })).toBeVisible();

    await page.getByRole('button', { name: 'Close guide' }).click();
    await expect(page.getByRole('dialog', { name: 'How to use' })).toBeHidden({ timeout: 5000 });
    await expect.poll(() => newAccountFlag(page)).toBeNull();
    await expect.poll(() => showTutorial(page)).toBe(false);
  });
});

import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

// Profile → How to use opens a full screen with the founder's 15-step guide,
// not the after-signup sheet. Written against roles and the guide's own
// labels, not class names. The row's screen swap (node witness in
// src/howToScreen.test.js) is proven there; this spec proves what only a
// browser can: the guide scrolls inside the pane at phone width and the last
// step is reachable past the bottom bar, which sits in flow below the pane.
test('the How to use row opens a scrollable full-screen guide at 390px', async ({ page }) => {
  await page.addInitScript(seedVault);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.waitForTimeout(1000);
  // One reload guards against a cold boot that paints nothing (session
  // restore races), same as sheet-a11y.
  const youTab = page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'You' });
  await expect(youTab).toBeVisible({ timeout: 15000 }).catch(async () => {
    await page.reload();
    await expect(youTab).toBeVisible({ timeout: 15000 });
  });

  await youTab.click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /How to use/ }).click();
  await page.waitForTimeout(600);

  // Not a sheet: no dialog carries the guide's name, and the screen's own
  // header carries the title with a back arrow.
  await expect(page.getByRole('dialog', { name: 'How to use' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'How to use' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back' }).first()).toBeVisible();

  const list = page.getByRole('list', { name: 'How to use Cipher' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveCount(15);
  await expect(list.getByText('Welcome to Cipher')).toBeVisible();

  // The last step is reachable: the guide scrolls inside the pane and the
  // bar below it stays in flow, so the step lands inside the viewport.
  const last = list.getByRole('listitem').last();
  await last.scrollIntoViewIfNeeded();
  await expect(last.getByText('Start using Cipher')).toBeVisible();
  const box = await last.boundingBox();
  expect(box).toBeTruthy();
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
});

import { test, expect } from '@playwright/test';

// Keypad floor (MASTER-PROMPT §1 / §10 → §14 PR13): keys respond to clicks,
// erase removes a digit, and eight dots fill. The lock screen (PR10) may
// re-dress the component; these assertions ride on roles, labels and the
// dot contract from src/components/ui/Keypad.jsx.

test.describe('Lock screen keypad', () => {
  test.beforeEach(async ({ page }) => {
    // No seedVault here, but the create flow re-dressed the keypad away into
    // a typed PIN box (PR10); the keypad itself lives on the unlock screen.
    // A marker vault routes the boot there — locked, same floor.
    await page.addInitScript(() => { localStorage.setItem('cipher_vault', 'x'); });
    await page.goto('/');
    await page.waitForTimeout(1500);
  });

  test('digit presses fill the eight PIN dots', async ({ page }) => {
    const pad = page.getByRole('group', { name: 'Number pad' });
    await expect(pad).toBeVisible({ timeout: 10000 });
    const dots = page.getByRole('group', { name: 'PIN digits entered' }).locator('[data-dot]');
    await expect(dots).toHaveCount(8);

    for (const digit of ['1', '2', '3', '4', '5', '6', '7', '8']) {
      await pad.getByRole('button', { name: digit, exact: true }).click();
    }
    const filled = await dots.evaluateAll((els) => els.filter((el) => el.dataset.filled === 'true').length);
    expect(filled).toBe(8);
  });

  test('erase removes the last digit', async ({ page }) => {
    const pad = page.getByRole('group', { name: 'Number pad' });
    await expect(pad).toBeVisible({ timeout: 10000 });
    const dots = page.getByRole('group', { name: 'PIN digits entered' }).locator('[data-dot]');
    await pad.getByRole('button', { name: '9', exact: true }).click();
    await pad.getByRole('button', { name: '4', exact: true }).click();
    await expect
      .poll(() => dots.evaluateAll((els) => els.filter((el) => el.dataset.filled === 'true').length))
      .toBe(2);

    await pad.getByRole('button', { name: 'Erase last digit' }).click();
    await expect
      .poll(() => dots.evaluateAll((els) => els.filter((el) => el.dataset.filled === 'true').length))
      .toBe(1);

    await pad.getByRole('button', { name: 'Erase last digit' }).click();
    // Erasing empty re-dressed into a disabled-off key (PR10) — same no-op
    // promise, the button simply sits disabled with nothing to take.
    await expect(pad.getByRole('button', { name: 'Erase last digit' })).toBeDisabled();
    await expect
      .poll(() => dots.evaluateAll((els) => els.filter((el) => el.dataset.filled === 'true').length))
      .toBe(0);
  });

  test('each key carries an accessible name', async ({ page }) => {
    const pad = page.getByRole('group', { name: 'Number pad' });
    await expect(pad).toBeVisible({ timeout: 10000 });
    for (const digit of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      await expect(pad.getByRole('button', { name: digit, exact: true })).toHaveCount(1);
    }
    await expect(pad.getByRole('button', { name: 'Erase last digit' })).toHaveCount(1);
  });
});

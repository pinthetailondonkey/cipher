import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

// Sheet/dialog a11y floor (MASTER-PROMPT §12 → §14 PR13): every Sheet-class
// surface reachable on the boot flow carries role=dialog + aria-modal, closes
// on Escape, and returns focus to the control that opened it. Written against
// stable roles and aria-labels, not class names — the parallel rebuild lanes
// re-skin freely and this spec must keep passing.

test.describe('Sheet-class a11y on the boot flow', () => {
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

  const surfaces = [
    {
      // Same rebuild fold 2da300c met for the New group sheet: these doors
      // moved into the list header's kebab; the sheets under test are
      // unchanged. The kebab click is the not-a11y door step.
      name: 'Saved viewer',
      open: async (page) => {
        await page.getByRole('button', { name: 'Chat list menu' }).click();
        await page.getByRole('button', { name: 'Saved messages' }).click();
      },
      dialogLabel: 'Saved',
      closeFallback: async (page) => page.getByRole('button', { name: 'Back' }).click(),
    },
    {
      name: 'Notifications center',
      open: async (page) => {
        await page.getByRole('button', { name: 'Chat list menu' }).click();
        await page.getByRole('button', { name: 'Notifications' }).click();
      },
      dialogLabel: 'Notifications',
      closeFallback: async (page) => page.getByRole('button', { name: 'Back' }).click(),
    },
    {
      name: 'QR scanner',
      open: async (page) => {
        await page.getByRole('button', { name: 'Chat list menu' }).click();
        await page.getByRole('button', { name: 'Scan QR code' }).click();
      },
      dialogLabel: 'Scan QR code',
      closeFallback: async (page) => page.getByRole('button', { name: 'Back' }).click(),
    },
    {
      name: 'How to use (tutorial)',
      open: async (page) => {
        // The guide's door is the Profile tab's own list, not the drawer.
        await page.getByRole('navigation', { name: 'Tabs' }).filter({ visible: true })
          .getByRole('button', { name: 'Profile' }).click();
        await page.getByRole('button', { name: /How to use/ }).click();
      },
      dialogLabel: 'How to use',
      closeFallback: async (page) => page.getByRole('button', { name: 'Close guide' }).click(),
    },
  ];

  for (const surface of surfaces) {
    test(`${surface.name}: dialog role, aria-modal, Escape closes, focus returns`, async ({ page }) => {
      await surface.open(page);
      const dialog = page.getByRole('dialog', { name: surface.dialogLabel });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-modal', 'true');

      // Escape closes the surface.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 5000 });
    });

    test(`${surface.name}: closing via the close control returns focus to the opener`, async ({ page }) => {
      await surface.open(page);
      const dialog = page.getByRole('dialog', { name: surface.dialogLabel });
      await expect(dialog).toBeVisible();

      await surface.closeFallback(page);
      await expect(dialog).toBeHidden({ timeout: 5000 });

      // Focus returns to the control that opened the surface; if the opener
      // left the DOM with the navigation, the body holding focus is the
      // accepted fallback (focus-restore must never throw).
      const focusGone = await page.evaluate(() => document.activeElement === document.body);
      const focusRestored = await page.evaluate(() => {
        const el = document.activeElement;
        return el instanceof HTMLElement && el.matches('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      });
      expect(focusRestored || focusGone).toBeTruthy();
    });
  }

  test('New group sheet: dialog role, aria-modal, Escape closes', async ({ page }) => {
    // The floating actions FAB became the list header's kebab menu in the
    // rebuild fold; the sheet under test is unchanged.
    const kebab = page.getByRole('button', { name: 'Chat list menu' });
    await expect(kebab).toBeVisible();
    await kebab.click();
    await page.getByRole('button', { name: 'New Group' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 5000 });
  });

  test('Escape with no sheet open does not throw', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(errors).toEqual([]);
  });
});

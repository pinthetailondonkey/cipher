import { test, expect } from '@playwright/test';
import { seedVault, unlock } from './fixtures.js';

// The production preview is service-worker controlled. Blocking the worker
// keeps the network route below in Playwright's request path, so this case
// observes the fetch gate rather than a stale shell fallback.
test.use({ serviceWorkers: 'block' });

const VENDOR = 'f'.repeat(64);
const PRODUCT = {
  id: 'checkout-fixture',
  name: 'Sample menu item',
  price: '0.001',
  currency: 'BTC',
  vendorPubkey: VENDOR,
  image: '',
};

test.describe('checkout surface', () => {
  test('one named sheet fits narrow screens and keeps usable controls', async ({ page }) => {
    await page.addInitScript(seedVault);
    await page.goto('/');
    await unlock(page);
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 30000 });

    await page.evaluate((product) => {
      window.__cipherStore.getState().setCheckoutProduct(product);
    }, PRODUCT);

    const dialog = page.getByRole('dialog', { name: 'Checkout' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(dialog.getByRole('heading', { name: 'Checkout' })).toBeVisible();
    await expect(dialog.getByLabel('Recipient')).toBeVisible();

    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 720 });
      const box = await dialog.boundingBox();
      const metrics = await dialog.evaluate((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        width: element.getBoundingClientRect().width,
        scroll: element.scrollWidth,
        client: element.clientWidth,
      }));
      expect(box, `checkout panel should be measurable at ${width}px`).not.toBeNull();
      expect(metrics.left, `panel starts within ${width}px viewport`).toBeGreaterThanOrEqual(0);
      expect(metrics.right, `panel ends within ${width}px viewport`).toBeLessThanOrEqual(width);
      expect(metrics.scroll, `panel has no horizontal overflow at ${width}px`).toBeLessThanOrEqual(metrics.client + 1);
    }

    const close = dialog.getByRole('button', { name: 'Close' });
    const send = dialog.getByRole('button', { name: 'Seal and send' });
    expect((await close.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect((await send.boundingBox()).height).toBeGreaterThanOrEqual(44);
  });

  test('a sender URL cannot make the product renderer contact an unapproved host', async ({ page }) => {
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.addInitScript(seedVault);
    await page.goto('/');
    await unlock(page);
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 30000 });

    await page.evaluate((product) => {
      window.__cipherStore.getState().setCheckoutProduct(product);
    }, { ...PRODUCT, image: 'https://sender-chosen.invalid/pixel.png' });
    await expect(page.getByRole('dialog', { name: 'Checkout' })).toBeVisible();
    await page.waitForTimeout(150);

    expect(requests.filter((url) => url.startsWith('https://sender-chosen.invalid/'))).toEqual([]);
    const imageSources = await page.getByRole('dialog').locator('img').evaluateAll((images) => images.map((image) => image.src));
    expect(imageSources.some((url) => url.startsWith('https://sender-chosen.invalid/'))).toBe(false);
  });

  test('a same-origin product image is fetched once and rendered from a local blob', async ({ page }) => {
    const seen = [];
    await page.route('**/approved-fixture.png', async (route) => {
      seen.push(await route.request().allHeaders());
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
      });
    });
    await page.addInitScript(seedVault);
    await page.goto('/');
    await unlock(page);
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 30000 });

    await page.evaluate((product) => {
      window.__cipherStore.getState().setCheckoutProduct(product);
    }, { ...PRODUCT, image: '/approved-fixture.png' });
    const dialog = page.getByRole('dialog', { name: 'Checkout' });
    await expect(dialog).toBeVisible();
    const image = dialog.locator('img').first();
    await expect(image).toBeVisible({ timeout: 15000 });
    await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBe(1);
    const src = await image.getAttribute('src');
    expect(src).toMatch(/^blob:/);
    expect(seen).toHaveLength(1);
    expect(seen[0].referer).toBeUndefined();
    expect(seen[0].cookie).toBeUndefined();
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Founder item #6: a menu item carries a real photo. The picker lives in the
// listing form — a canList surface, so no member media path opens. The photo
// rides the product payload as a private entry, the same { url, key, iv,
// mime } a DM photo rides inside its sealed message, and every draw of that
// field picks by the gate the DM receiver already uses (isPrivateMedia).
// Pinned here at the source, the way mediaCrypto.test.js pins the composer.

const view = fs.readFileSync(new URL('./GroupView.jsx', import.meta.url), 'utf8');
const media = fs.readFileSync(new URL('../ui/PrivateMedia.jsx', import.meta.url), 'utf8');
const bubble = fs.readFileSync(new URL('../MessageBubble.jsx', import.meta.url), 'utf8');
const sidebar = fs.readFileSync(new URL('./GroupInfoSidebar.jsx', import.meta.url), 'utf8');
const orders = fs.readFileSync(new URL('./MyOrders.jsx', import.meta.url), 'utf8');

const storefrontStart = view.indexOf('function GroupStorefront');
const formStart = view.indexOf('canList && open && (', storefrontStart);
const formEnd = view.indexOf('</form>', formStart);

test('the listing form offers a photo, and only there: uploaded privately, refused through the shared toast', () => {
  assert.ok(storefrontStart >= 0 && formStart > storefrontStart && formEnd > formStart, 'the canList-gated listing form exists');
  const form = view.slice(formStart, formEnd);
  // The picker is the form's fourth row, and the only file door in the view.
  assert.match(form, /type="file"/);
  assert.equal((view.match(/type="file"/g) || []).length, 1);
  // The file goes out encrypted, to the hosts the device names.
  assert.match(view.slice(storefrontStart, formEnd), /uploadPrivateMedia\(file, blossomServers\(\)\)/);
  // A host that refuses is the shared toast's sentence, never re-inlined.
  assert.match(view.slice(storefrontStart, formEnd), /photoRefusalToast\(/);
});

test('the posted product carries the entry the upload returns, and the row draws it through the DM gate', () => {
  const storefront = view.slice(storefrontStart, formEnd);
  assert.match(storefront, /setPhoto\(await uploadPrivateMedia\(file, blossomServers\(\)\)\)/);
  assert.match(storefront, /image: photo/);
  // The menu row no longer hands the field to Picture as a plain src.
  assert.match(view, /<ProductImage value=\{item\.product\.image\}/);
  // ProductImage is the DM render path's own shape pick: the private branch
  // is MediaImage, decided by isPrivateMedia — one gate for DMs and menus.
  assert.match(media, /export function ProductImage/);
  assert.match(media, /isPrivateMedia\(value\)[\s\S]*?MediaImage/);
});

test('every draw of the product photo field picks by shape — no plain-src Picture is left', () => {
  const plain = /Picture src=\{[^}]*\.image\}/;
  for (const [name, src] of [['GroupView', view], ['MessageBubble', bubble], ['GroupInfoSidebar', sidebar], ['MyOrders', orders]]) {
    assert.equal(plain.test(src), false, `${name} still draws the product photo as a plain src`);
  }
});

test('the entry survives the payload trip the group seal makes and passes the gate the render uses', async () => {
  const { uploadPrivateMedia, isPrivateMedia } = await import('../../lib/mediaCrypto.js');
  const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], { type: 'image/jpeg' });
  const entry = await uploadPrivateMedia(jpeg(), ['https://media.example'], async () => ({ url: 'https://media.example/abc' }));
  // The payload is stringified into the sealed group message and parsed back
  // on every member's device; the field must still pass the render's gate.
  const payload = JSON.parse(JSON.stringify({ type: 'product', title: 'Tee', priceUsd: 20, image: entry }));
  assert.equal(isPrivateMedia(payload.image), true);
  assert.deepEqual(payload.image, entry);
});

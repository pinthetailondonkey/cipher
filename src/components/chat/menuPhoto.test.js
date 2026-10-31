import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

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
const edit = fs.readFileSync(new URL('./ProductEditModal.jsx', import.meta.url), 'utf8');

const storefrontStart = view.indexOf('function GroupStorefront');
const formStart = view.indexOf('canList && open && (', storefrontStart);
const formEnd = view.indexOf('</form>', formStart);

test('the listing form offers a photo, and only there: uploaded privately, refused through the shared toast', () => {
  assert.ok(storefrontStart >= 0 && formStart > storefrontStart && formEnd > formStart, 'the canList-gated listing form exists');
  const form = view.slice(formStart, formEnd);
  // The picker is the form's fourth row, and the only file door in the view.
  assert.match(form, /type="file"/);
  assert.equal((view.match(/type="file"/g) || []).length, 1);
  // The file goes out encrypted, to the hosts the device names. It takes the
  // attachment door, which re-encodes a photo before encrypting it; the raw
  // upload is no longer reachable from this picker.
  assert.match(view.slice(storefrontStart, formEnd), /uploadAttachment\(file, blossomServers\(\)\)/);
  assert.doesNotMatch(view.slice(storefrontStart, formEnd), /uploadPrivateMedia\(file, blossomServers\(\)\)/);
  // A host that refuses is the shared toast's sentence, never re-inlined.
  assert.match(view.slice(storefrontStart, formEnd), /photoRefusalToast\(/);
});

test('the posted product carries the entry the upload returns, and the row draws it through the DM gate', () => {
  const storefront = view.slice(storefrontStart, formEnd);
  assert.match(storefront, /setPhoto\(await uploadAttachment\(file, blossomServers\(\)\)\)/);
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

// The seller's own bubble offers "Edit listing" and the sheet is seeded from
// the payload — which now carries the entry object. An input handed that
// object shows "[object Object]", and image.trim() throws before onSubmit
// ever runs: the save silently does nothing. The URL box is for a plain
// string only; an attached entry is named, kept whole (key included) through
// submit, and only typing a URL replaces it.
test('editing a listing keeps an attached photo whole, and the URL box serves only a plain one', () => {
  // The entry is what is held and sent, never a flattened string. The naive
  // fix — String(image) or image.url — would write "[object Object]" into the
  // listing: the key and iv are gone and the buyer's photo is permanently
  // broken with no error anywhere.
  assert.match(edit, /const image = isPrivateMedia\(photo\) \? photo : String\(photo \|\| ''\)\.trim\(\);/);
  assert.match(edit, /setPhoto\(product\?\.image \|\| null\)/);
  // Submit never calls .trim() on the entry, only on the URL text.
  assert.equal(/image\.trim\(\)/.test(edit), false);
  // The URL box renders for a plain string alone; an entry gets the words.
  assert.match(edit, /\{isPrivateMedia\(photo\) \? \(/);
  assert.match(edit, /Photo attached/);
  // The photo the listing arrived with is held for "Keep the photo", and the
  // offer is gated on it — a plain-URL listing has nothing to restore.
  assert.match(edit, /const attached = isPrivateMedia\(product\?\.image\) \? product\.image : null;/);
  assert.match(edit, /\{attached && <Button[\s\S]*?>Keep the photo<\/Button>\}/);
  // The image field is never a String state that swallows the entry.
  assert.match(edit, /useState\(null\);/);
});

// The edit door renders for real: the sheet is bundled with the project's
// own bundler against the hooks shim the chat list test uses, so "[object
// Object]" and the throw are measured, not inferred. The naive fix —
// String(image) or image.url — would write "[object Object]" into the
// listing: the key and iv are gone and the buyer's photo is permanently
// broken with no error anywhere. The entry has to survive untouched unless
// the seller types a new URL.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUNDLE = path.resolve(ROOT, 'node_modules', '.cipher-menuphoto-test');
let editApp = null;

before(async () => {
  fs.rmSync(BUNDLE, { recursive: true, force: true });
  fs.mkdirSync(BUNDLE, { recursive: true });
  const chatList = fs.readFileSync(new URL('./chatList.test.js', import.meta.url), 'utf8');
  fs.writeFileSync(path.join(BUNDLE, 'react-shim.js'), chatList.match(/const REACT_SHIM = `([\s\S]*?)`;/)[1]);
  fs.writeFileSync(path.join(BUNDLE, 'jsx-shim.js'), chatList.match(/const JSX_SHIM = `([\s\S]*?)`;/)[1]);
  fs.writeFileSync(path.join(BUNDLE, 'jsx-runtime.js'), "export * from './jsx-shim.js';");
  fs.writeFileSync(path.join(BUNDLE, 'react-dom-shim.js'), 'export const createPortal = (children) => children;\n');
  fs.writeFileSync(path.join(BUNDLE, 'entry.js'), `
export { default as ProductEditModal } from ${JSON.stringify(path.join(ROOT, 'src/components/chat/ProductEditModal.jsx'))};
export * as hooks from './react-shim.js';
`);
  const alias = {
    react: path.join(BUNDLE, 'react-shim.js'),
    'react/jsx-runtime': path.join(BUNDLE, 'jsx-runtime.js'),
    'react-dom': path.join(BUNDLE, 'react-dom-shim.js'),
  };
  const { rolldown } = await import('rolldown');
  const bundle = await rolldown({
    input: path.join(BUNDLE, 'entry.js'),
    external: (id) => !id.startsWith('.') && !path.isAbsolute(id) && !alias[id],
    platform: 'node',
    resolve: { alias },
  });
  await bundle.write({ dir: BUNDLE, format: 'esm', entryFileNames: 'app.mjs', chunkFileNames: '[name]-chunk.js' });
  editApp = await import(`${path.join(BUNDLE, 'app.mjs')}?v=${Date.now()}`);
});

after(() => { fs.rmSync(BUNDLE, { recursive: true, force: true }); });

function createTree(component, props) {
  const instances = new Map();
  let hosts = [];
  const walk = (node, at) => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (Array.isArray(node)) { node.forEach((child, index) => walk(child, `${at}.${index}`)); return; }
    if (typeof node !== 'object') return;
    const { type, props: ownProps = {} } = node;
    if (type === Symbol.for('react.fragment')) { walk(ownProps.children, at); return; }
    if (typeof type === 'string') {
      const host = { tag: type, props: ownProps };
      hosts.push(host);
      walk(ownProps.children, `${at}/${type}`);
      return;
    }
    if (typeof type !== 'function' || type.name === 'AnimatePresence') { walk(ownProps.children, at); return; }
    const instance = instances.get(at) || { slots: [], cursor: 0 };
    instances.set(at, instance);
    editApp.hooks.__setCurrent(instance);
    const output = type(ownProps);
    editApp.hooks.__clearCurrent();
    walk(output, `${at}/${type.name}`);
    for (const effect of editApp.hooks.__takeEffects()) effect();
  };
  return { render: () => { hosts = []; walk({ type: component, props }, 'root'); return hosts; } };
}

const textOf = (node) => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && node.props) return textOf(node.props.children);
  return '';
};

// The sheet portals to document.body and its a11y hook binds the window; the
// shim tree is not a browser, so both are stubbed for the render.
const withDocument = (run) => {
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { body: { style: {} } };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try { return run(); } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
  }
};

const entry = { url: 'https://media.example/abc', key: 'k'.repeat(43), iv: 'i'.repeat(16), mime: 'image/jpeg' };
const listing = (image) => ({ type: 'product', title: 'Tee', priceUsd: 20, description: 'Soft.', image });
const typeInto = (hosts, label, value) => hosts.find((host) => host.props['aria-label'] === label).props.onChange({ target: { value } });
const ng = (hosts, name) => hosts.find((host) => host.tag === 'button' && textOf(host.props.children) === name);
// The sheet seeds its fields in an effect, so the settled screen is the
// second render — the first only registers it.
const settled = (tree) => { tree.render(); return tree.render(); };

test('saving a listing whose photo is an entry sends the same object, key and iv intact', () => {
  withDocument(() => {
    const calls = [];
    const tree = createTree(editApp.ProductEditModal, {
      editingProduct: { msg: { id: 'm1', data: listing(entry) } },
      onClose: () => {},
      onSubmit: (product) => calls.push(product),
    });
    let hosts = settled(tree);
    // Untouched save: the same object, deep-equal on every field. At the tip
    // image.trim() throws here, so nothing reaches onSubmit at all.
    hosts.find((host) => host.tag === 'form').props.onSubmit({ preventDefault() {} });
    assert.equal(calls.length, 1, 'Save listing submits');
    assert.equal(calls[0].image, entry, 'the very object is handed over');
    assert.deepEqual(calls[0].image, { url: entry.url, key: entry.key, iv: entry.iv, mime: entry.mime });
    // Named on screen, never stringified into the input.
    assert.match(hosts.map((host) => textOf(host.props.children)).join(' '), /Photo attached/);
  });
});

test('typing a new URL replaces the photo with that string', () => {
  withDocument(() => {
    const calls = [];
    // A plain URL listing opens in the box as before.
    const plainTree = createTree(editApp.ProductEditModal, { editingProduct: { msg: { id: 'm2', data: listing('https://old.example/a.jpg') } }, onClose: () => {}, onSubmit: () => {} });
    let hosts = settled(plainTree);
    assert.equal(hosts.find((host) => host.props['aria-label'] === 'Image URL').props.value, 'https://old.example/a.jpg');
    const tree = createTree(editApp.ProductEditModal, {
      editingProduct: { msg: { id: 'm1', data: listing(entry) } },
      onClose: () => {},
      onSubmit: (product) => calls.push(product),
    });
    hosts = settled(tree);
    // The box comes back for a URL, and what is typed replaces the entry.
    ng(hosts, 'Use a URL').props.onClick();
    hosts = tree.render();
    typeInto(hosts, 'Image URL', 'https://new.example/b.jpg');
    hosts = tree.render();
    hosts.find((host) => host.tag === 'form').props.onSubmit({ preventDefault() {} });
    assert.equal(calls[0].image, 'https://new.example/b.jpg', 'the typed string is the image');
  });
});

test('the shape held decides the row: a box for a plain URL, words for an entry', () => {
  withDocument(() => {
    const plainTree = createTree(editApp.ProductEditModal, { editingProduct: { msg: { id: 'm2', data: listing('https://old.example/a.jpg') } }, onClose: () => {}, onSubmit: () => {} });
    const plainHosts = settled(plainTree);
    assert.ok(plainHosts.find((host) => host.props['aria-label'] === 'Image URL'), 'a plain URL gets the box');
    assert.equal(/Photo attached/.test(plainHosts.map((host) => textOf(host.props.children)).join(' ')), false);
    const entryTree = createTree(editApp.ProductEditModal, { editingProduct: { msg: { id: 'm1', data: listing(entry) } }, onClose: () => {}, onSubmit: () => {} });
    const entryHosts = settled(entryTree);
    assert.equal(entryHosts.some((host) => host.props['aria-label'] === 'Image URL'), false, 'no box is handed the entry object');
    assert.match(entryHosts.map((host) => textOf(host.props.children)).join(' '), /Photo attached/);
  });
});

// "Use a URL" drops the entry from state. Closing the sheet used to be the
// only way back, and it re-seeds from the payload — a misclick lost a photo
// the upload had already paid for. The sheet it was opened on still holds the
// entry, so it offers that entry back while the box is showing, and only for
// a listing that has one.
test('a misclicked URL box offers the original photo back, whole', () => {
  withDocument(() => {
    const calls = [];
    const tree = createTree(editApp.ProductEditModal, {
      editingProduct: { msg: { id: 'm1', data: listing(entry) } },
      onClose: () => {},
      onSubmit: (product) => calls.push(product),
    });
    let hosts = settled(tree);
    ng(hosts, 'Use a URL').props.onClick();
    hosts = tree.render();
    assert.ok(hosts.find((host) => host.props['aria-label'] === 'Image URL'), 'the box is showing');
    ng(hosts, 'Keep the photo').props.onClick();
    hosts = tree.render();
    assert.equal(hosts.some((host) => host.props['aria-label'] === 'Image URL'), false, 'the box gives way to the photo again');
    hosts.find((host) => host.tag === 'form').props.onSubmit({ preventDefault() {} });
    assert.equal(calls[0].image, entry, 'the very object is back, untouched');
    assert.deepEqual(calls[0].image, { url: entry.url, key: entry.key, iv: entry.iv, mime: entry.mime });
  });
});

test('a plain-URL listing has no photo to keep, so the offer is absent', () => {
  withDocument(() => {
    const tree = createTree(editApp.ProductEditModal, { editingProduct: { msg: { id: 'm2', data: listing('https://old.example/a.jpg') } }, onClose: () => {}, onSubmit: () => {} });
    const hosts = settled(tree);
    assert.ok(hosts.find((host) => host.props['aria-label'] === 'Image URL'));
    assert.equal(hosts.some((host) => host.tag === 'button' && textOf(host.props.children) === 'Keep the photo'), false, 'nothing to restore');
  });
});

test('the edit payload carries the image field unchanged to the group message', () => {
  const commerce = fs.readFileSync(new URL('../../features/chat/useCommerce.js', import.meta.url), 'utf8');
  assert.match(commerce, /image: updatedProduct\.image/);
  assert.equal(/image: String\(updatedProduct\.image/.test(commerce), false);
});

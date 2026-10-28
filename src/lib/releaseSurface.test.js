import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { deliveryMissMap, emptyDelivery, withFieldMiss } from './deliveryAddress.js';
import { listingPublishOutcome, productShareLink } from './listing.js';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

// ————— a share link leaves this machine —————

test('a product link is built on the canonical app host, not the window it was made in', () => {
  const link = productShareLink({ id: 'p-1', vendorPubkey: 'v-1' }, 'https://www.ciphermessenger.org');
  assert.equal(link, 'https://www.ciphermessenger.org/?product=p-1&vendor=v-1');
  // A loopback base is only used when the caller passes nothing at all.
  assert.equal(productShareLink({ id: 'p 1', vendorPubkey: 'v&1' }, ''), '', 'no window in node, no invented host');
  assert.equal(productShareLink({ id: '', vendorPubkey: 'v' }, 'https://www.ciphermessenger.org'), '');
  assert.equal(productShareLink({ id: 'p', vendorPubkey: '' }, 'https://www.ciphermessenger.org'), '');
});

test('the menus screen shares the canonical host and nothing else', () => {
  const menus = read('../Menus.jsx');
  assert.match(menus, /const APP_HOST_URL = entryById\('app-host'\)\?\.url \|\| ''/);
  assert.match(menus, /copyText\(productShareLink\(product, APP_HOST_URL\)\)/);
  assert.equal(/window\.location\.origin/.test(menus), false, 'a loopback origin is never a share link');
});

// ————— clipboard success is a resolved write —————

test('the profile key and the product link only say Copied after the write lands', () => {
  const wallet = read('../Wallet.jsx');
  assert.match(wallet, /const ok = await copyText\(identity\.npub\)/);
  assert.match(wallet, /if \(!ok\) \{\s*setCopied\(false\);\s*return;\s*\}/);
  assert.equal(/^\s*copyText\(identity\.npub\);\s*$/m.test(wallet), false, 'no fire-and-forget copy');
  const menus = read('../Menus.jsx');
  assert.match(menus, /const shareProduct = async \(product\) => copyText\(productShareLink/);
});

// ————— a field speaks only after it is left —————

test('typing in one field never paints another field\'s miss', () => {
  const form = { ...emptyDelivery() };
  // A field that has not spoken stays quiet while another field is typed in.
  assert.deepEqual(withFieldMiss({}, { ...form, city: 'Austin' }, 'city'), {});
  // A field that already spoke updates only its own line.
  const spoken = { name: 'Who is this going to?', city: 'Which city?' };
  const typed = withFieldMiss(spoken, { ...form, city: 'Austin' }, 'city');
  assert.deepEqual(typed, { name: 'Who is this going to?' });
  // Leaving a field is what makes it speak.
  const blurred = withFieldMiss({}, form, 'postalCode');
  assert.deepEqual(blurred, { postalCode: 'Check the postal code.' });
  // Send asks every field at once.
  assert.deepEqual(
    Object.keys(deliveryMissMap(emptyDelivery())),
    ['name', 'street', 'city', 'state', 'postalCode']
  );
});

test('the checkout keeps its errors per field and still gates on every required field', () => {
  const checkout = read('../components/OneTapCheckout.jsx');
  assert.match(checkout, /const map = deliveryMissMap\(delivery\);\s*\n\s*setMisses\(map\);/);
  assert.match(checkout, /spec\.field in current \? withFieldMiss\(current, next, spec\.field\) : current/);
  assert.match(checkout, /onBlur=\{\(\) => setMisses\(\(current\) => withFieldMiss\(current, delivery, spec\.field\)\)\}/);
  assert.equal(/checkDelivery/.test(checkout), false);
  // The address still travels sealed in the note, and the required set is untouched.
  assert.match(checkout, /createDeadDropNote\(\{/);
  assert.match(checkout, /if \(deliveryMisses\(delivery\)\.length\) return;/);
});

// ————— a publish says only what happened —————

test('a publish claims queued only when the outbox actually holds it', () => {
  assert.deepEqual(listingPublishOutcome(true, false), { delivery: 'published', status: 'Published.', ok: true });
  assert.deepEqual(listingPublishOutcome(false, true), { delivery: 'queued', status: 'Saved and will send.', ok: true });
  const failed = listingPublishOutcome(false, false);
  assert.equal(failed.ok, false);
  assert.equal(failed.delivery, null);
  assert.equal(/Saved and will send/.test(failed.status), false, 'a failed enqueue never borrows the queued words');
});

test('the new-listing form defaults to a coin and says what USD cannot do', () => {
  const wallet = read('../Wallet.jsx');
  assert.match(wallet, /const \[currency, setCurrency\] = useState\('BTC'\)/);
  assert.match(wallet, /<option value="BTC">BTC<\/option><option value="XMR">XMR<\/option><option value="USD">USD<\/option>/);
  assert.match(wallet, /A USD price is a dollar figure only/);
});

test('the listing send reports the outbox\'s real answer and keeps the form when neither door took it', () => {
  const wallet = read('../Wallet.jsx');
  assert.match(wallet, /await enqueueNostrEvent\(ev, relays\)\s*\n\s*queued = true/);
  assert.match(wallet, /const outcome = listingPublishOutcome\(accepted, queued\)/);
  const failure = wallet.slice(wallet.indexOf('if (!outcome.ok)'), wallet.indexOf('const newProduct ='));
  assert.match(failure, /setStatus\(outcome\.status\)/);
  assert.match(failure, /return/);
  assert.equal(/setTitle\(''\)/.test(failure), false, 'the form keeps what was typed for the retry');
  assert.match(wallet, /delivery: outcome\.delivery/);
  assert.match(wallet, /setStatus\(outcome\.status\)\s*\n\s*setTitle\(''\)/);
});

// ————— menu discovery offers the retry it names —————

test('the menu error state can ask the same loader again, one fetch at a time', () => {
  const menus = read('../Menus.jsx');
  assert.match(menus, /const loadMenu = useCallback\(async \(\) => \{/);
  assert.match(menus, /if \(loadingRef\.current\) return;/);
  assert.match(menus, /onClick=\{\(\) => \{ haptic\('light'\); loadMenu\(\); \}\}/);
  assert.match(menus, />\s*Try again\s*</);
  assert.match(menus, /!loading && error/);
  assert.match(menus, /!loading && !error && sections\.length === 0/, 'a failed fetch never renders as an empty menu');
});

// ————— the edit-profile sheet has a name —————

test('the edit-profile sheet is announced by name, and the shared sheet is untouched', () => {
  const wallet = read('../Wallet.jsx');
  assert.match(wallet, /<Sheet open onClose=\{\(\) => setView\('main'\)\} label="Edit Profile">/);
  const sheet = read('../components/ui/Sheet.jsx');
  assert.match(sheet, /aria-label=\{!labelledBy \?/);
});

// ————— the buyer-mode notice waits for the wipe —————

test('the buyer-mode notice never says cleared when the wipe failed', () => {
  const wallet = read('../Wallet.jsx');
  const handler = wallet.slice(wallet.indexOf('title="Switch to buyer mode"'), wallet.indexOf('<ListRow icon={Package} title="Order settings"'));
  const failure = handler.slice(handler.indexOf('catch (wipeError)'), handler.indexOf('setBtcAddress(\'\')'));
  assert.match(failure, /still on this device/);
  assert.equal(/Payment details were cleared/.test(failure), false);
  const success = handler.slice(handler.indexOf('setBtcAddress(\'\')'));
  assert.match(success, /Payment details were cleared from this device/);
});

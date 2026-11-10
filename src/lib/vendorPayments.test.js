import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { HDKey } from '@scure/bip32';
import { getPublicKey } from 'nostr-tools/pure';
import {
  addressSpokenFor,
  deriveBitcoinAddress,
  getOrderPaymentMethods,
  loadVendorPaymentConfig,
  markConsumed,
  readConsumedLedger,
  readPaymentAddresses,
  savePaymentAddresses,
  saveVendorPaymentConfig,
  txidSpokenFor,
} from './vendorPayments.js';
import { resetScopeMigration } from './storage.js';
import { activateBitcoinAllocationContext, descriptorId, initializeBitcoinDescriptor,
  reserveBitcoinIndex, retireBitcoinAllocationContext } from './commerceWalletStore.js';

test('a Bitcoin address uses bc on mainnet and bcrt on regtest', async () => {
  const xpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(1)).derive("m/84'/0'/0'").publicExtendedKey;
  const mainnet = await deriveBitcoinAddress(xpub, 0, 'bc');
  const regtest = await deriveBitcoinAddress(xpub, 0, 'bcrt');
  const implied = await deriveBitcoinAddress(xpub, 0);
  assert.equal(mainnet.startsWith('bc1'), true);
  assert.equal(regtest.startsWith('bcrt1'), true);
  assert.equal(implied, mainnet);
  assert.notEqual(mainnet.slice(mainnet.indexOf('1')), regtest.slice(regtest.indexOf('1')));
  await assert.rejects(() => deriveBitcoinAddress(xpub, 0, 'signet'), /network/);
});

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    key: (index) => Array.from(data.keys())[index] ?? null,
    get length() { return data.size; },
  };
}

test('a main address belongs to one account, and a device-wide copy is never handed to another', () => {
  const a = 'aaaaaaaa' + '1'.repeat(56);
  const b = 'bbbbbbbb' + '2'.repeat(56);
  globalThis.localStorage = memoryStorage({
    cipher_vaults: JSON.stringify({ [a]: {}, [b]: {} }),
    cipher_active_pubkey: a,
  });
  savePaymentAddresses({ btc: ' bc1qaccounta ', xmr: '' }, {
    context: { owner: a },
    assertCurrent() {},
  });
  assert.deepEqual(readPaymentAddresses(), { btc: 'bc1qaccounta', xmr: '' });
  // An older build also left device-wide copies behind.
  localStorage.setItem('cipher_btc_address', 'bc1qaccounta');
  localStorage.setItem('cipher_btc', 'bc1qaccounta');
  localStorage.setItem('cipher_active_pubkey', b);
  assert.deepEqual(readPaymentAddresses(), { btc: '', xmr: '' });
  assert.equal(localStorage.getItem('cipher_btc_address'), null);
  assert.equal(localStorage.getItem('cipher_btc'), null);
  localStorage.setItem('cipher_active_pubkey', a);
  assert.equal(readPaymentAddresses().btc, 'bc1qaccounta');
});

test('a retired account context cannot write vendor receiving addresses', () => {
  const owner = 'dddddddd' + '4'.repeat(56);
  globalThis.localStorage = memoryStorage({ cipher_active_pubkey: owner });
  const fence = {
    context: { owner },
    assertCurrent() {
      const error = new Error('retired');
      error.code = 'SECURITY_CONTEXT_EXPIRED';
      throw error;
    },
  };
  assert.throws(
    () => savePaymentAddresses({ btc: 'bc1qstale', xmr: 'stale' }, fence),
    { code: 'SECURITY_CONTEXT_EXPIRED' },
  );
  assert.equal(localStorage.getItem(`cipher_${owner}_btc_address`), null);
  assert.equal(localStorage.getItem(`cipher_${owner}_xmr_address`), null);
});

test('a single-account device adopts its old device-wide address once', () => {
  const only = 'cccccccc' + '3'.repeat(56);
  resetScopeMigration();
  globalThis.localStorage = memoryStorage({
    cipher_vaults: JSON.stringify({ [only]: {} }),
    cipher_active_pubkey: only,
    cipher_xmr: '8legacy',
  });
  assert.deepEqual(readPaymentAddresses(), { btc: '', xmr: '8legacy' });
  assert.equal(localStorage.getItem('cipher_xmr'), null);
  assert.equal(localStorage.getItem(`cipher_${only}_xmr_address`), '"8legacy"');
});

const vendorSk = new Uint8Array(32).fill(7);
const vendor = { pk: getPublicKey(vendorSk), sk: vendorSk };
const SHARED = 'bc1qsharedaddress0000000000000000000000000000000000000000000000';

test('an order is issued its own address, never the account\'s shared one', async () => {
  globalThis.localStorage = memoryStorage({ cipher_active_pubkey: vendor.pk });
  // Without derivation keys there is no address of its own to give, so the
  // acceptance refuses instead of parking the order on the shared address.
  await assert.rejects(
    () => getOrderPaymentMethods(vendor, 'order-1', { btc: SHARED, xmr: '' }, 'btc'),
    /own address/,
  );
  const xpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(2)).derive("m/84'/0'/0'").publicExtendedKey;
  await saveVendorPaymentConfig(vendor, { btcXpub: xpub, xmrPrivateViewKey: '', btcNetwork: 'bcrt' });
  const methods = await getOrderPaymentMethods(vendor, 'order-1', { btc: SHARED, xmr: '' }, 'btc');
  assert.notEqual(methods.btc, SHARED);
  assert.ok(methods.btc.startsWith('bcrt1'));
  // The same order asks again and gets the address it was issued, not a new one.
  const again = await getOrderPaymentMethods(vendor, 'order-1', { btc: SHARED, xmr: '' }, 'btc');
  assert.equal(again.btc, methods.btc);
  // A second order gets a different fresh address, never the shared one.
  const second = await getOrderPaymentMethods(vendor, 'order-2', { btc: SHARED, xmr: '' }, 'btc');
  assert.notEqual(second.btc, methods.btc);
  assert.notEqual(second.btc, SHARED);
});

test('IndexedDB reservations serialize concurrent tabs and retry the same order idempotently', async () => {
  const owner = getPublicKey(new Uint8Array(32).fill(19));
  const descriptor = 'descriptor-cross-tab-fixture';
  await initializeBitcoinDescriptor({ owner, descriptor, explicitlyNew: true });
  const [one, two] = await Promise.all([
    reserveBitcoinIndex({ owner, descriptor, orderId: 'parallel-one' }),
    reserveBitcoinIndex({ owner, descriptor, orderId: 'parallel-two' }),
  ]);
  assert.notEqual(one.index, two.index);
  const retry = await reserveBitcoinIndex({ owner, descriptor, orderId: 'parallel-one' });
  assert.equal(retry.index, one.index);
  const after = await reserveBitcoinIndex({ owner, descriptor, orderId: 'after-retry' });
  assert.notEqual(after.index, one.index);
  assert.notEqual(after.index, two.index);
});

test('allocation fails closed when the durable authority head is missing', async () => {
  const owner = getPublicKey(new Uint8Array(32).fill(24));
  await assert.rejects(
    () => reserveBitcoinIndex({ owner, descriptor: 'restored-without-head', orderId: 'order' }),
    { code: 'WALLET_ALLOCATION_RECOVERY_REQUIRED' },
  );
});

test('a stale settings backup cannot rewind the durable allocation head', async () => {
  const identitySk = new Uint8Array(32).fill(20);
  const identity = { sk: identitySk, pk: getPublicKey(identitySk) };
  globalThis.localStorage = memoryStorage({ cipher_active_pubkey: identity.pk });
  const xpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(21)).derive("m/84'/0'/0'").publicExtendedKey;
  await saveVendorPaymentConfig(identity, { btcXpub: xpub, btcNetwork: 'bcrt' });
  const backup = localStorage.getItem(`cipher_${identity.pk}_advanced_vendor_payment_keys`);
  const issued = await getOrderPaymentMethods(identity, 'disclosed-order', {}, 'btc');
  localStorage.setItem(`cipher_${identity.pk}_advanced_vendor_payment_keys`, backup);
  const next = await getOrderPaymentMethods(identity, 'later-order', {}, 'btc');
  assert.notEqual(next.btc, issued.btc);
});

test('an interrupted settings write leaves the address index reserved for an idempotent retry', async () => {
  const sk = new Uint8Array(32).fill(25);
  const identity = { sk, pk: getPublicKey(sk) };
  const storage = memoryStorage({ cipher_active_pubkey: identity.pk });
  globalThis.localStorage = storage;
  const xpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(26)).derive("m/84'/0'/0'").publicExtendedKey;
  await saveVendorPaymentConfig(identity, { btcXpub: xpub, btcNetwork: 'bcrt' });
  const key = `cipher_${identity.pk}_advanced_vendor_payment_keys`;
  const set = storage.setItem;
  let interrupt = true;
  storage.setItem = (name, value) => {
    if (name === key && interrupt) { interrupt = false; throw new Error('injected interrupted settings write'); }
    return set(name, value);
  };
  await assert.rejects(() => getOrderPaymentMethods(identity, 'retry-order', {}, 'btc'), /interrupted settings write/);
  storage.setItem = set;
  const retried = await getOrderPaymentMethods(identity, 'retry-order', {}, 'btc');
  const following = await getOrderPaymentMethods(identity, 'following-order', {}, 'btc');
  assert.notEqual(retried.btc, following.btc);
});

test('changing descriptors after multiple Bitcoin orders preserves mappings and finalizes the new branch index', async () => {
  const sk = new Uint8Array(32).fill(27);
  const identity = { sk, pk: getPublicKey(sk) };
  globalThis.localStorage = memoryStorage({ cipher_active_pubkey: identity.pk });
  const first = HDKey.fromMasterSeed(new Uint8Array(32).fill(28)).derive("m/84'/0'/0'").publicExtendedKey;
  const second = HDKey.fromMasterSeed(new Uint8Array(32).fill(29)).derive("m/84'/0'/0'").publicExtendedKey;
  await saveVendorPaymentConfig(identity, { btcXpub: first, btcNetwork: 'bcrt' });
  const oldOrders = await Promise.all(['old-descriptor-order-1', 'old-descriptor-order-2', 'old-descriptor-order-3'].map((orderId) => getOrderPaymentMethods(identity, orderId, {}, 'btc')));
  await saveVendorPaymentConfig(identity, { btcXpub: second, btcNetwork: 'bcrt' });
  const newOrder = await getOrderPaymentMethods(identity, 'new-descriptor-order', {}, 'btc');
  assert.ok(oldOrders.every((row) => row.btc !== newOrder.btc));
  assert.equal((await getOrderPaymentMethods(identity, 'old-descriptor-order-1', {}, 'btc')).btc, oldOrders[0].btc);
});

test('switching back to a descriptor with preserved orders but a missing head holds for recovery', async () => {
  const sk = new Uint8Array(32).fill(39);
  const identity = { sk, pk: getPublicKey(sk) };
  globalThis.localStorage = memoryStorage({ cipher_active_pubkey: identity.pk });
  const first = HDKey.fromMasterSeed(new Uint8Array(32).fill(40)).derive("m/84'/0'/0'").publicExtendedKey;
  const second = HDKey.fromMasterSeed(new Uint8Array(32).fill(41)).derive("m/84'/0'/0'").publicExtendedKey;
  await saveVendorPaymentConfig(identity, { btcXpub: first, btcNetwork: 'bcrt' });
  const firstOrders = await Promise.all(['return-a-1', 'return-a-2'].map((orderId) => getOrderPaymentMethods(identity, orderId, {}, 'btc')));
  await saveVendorPaymentConfig(identity, { btcXpub: second, btcNetwork: 'bcrt' });
  const secondOrder = await getOrderPaymentMethods(identity, 'return-b-1', {}, 'btc');

  const descriptor = await descriptorId(first, 'bcrt');
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('cipher-commerce-wallet-allocator-v1', 3);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const headId = `${identity.pk.length}:${identity.pk}|${descriptor.length}:${descriptor}`;
  await new Promise((resolve, reject) => {
    const tx = database.transaction('heads', 'readwrite');
    tx.objectStore('heads').delete(headId);
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
  database.close();

  await assert.rejects(
    () => saveVendorPaymentConfig(identity, { btcXpub: first, btcNetwork: 'bcrt' }),
    { code: 'WALLET_ALLOCATION_RECOVERY_REQUIRED' },
  );
  assert.equal(localStorage.getItem(`cipher_${identity.pk}_advanced_vendor_payment_keys`) !== null, true);
  assert.notEqual(firstOrders[0].btc, firstOrders[1].btc);
  assert.notEqual(secondOrder.btc, firstOrders[0].btc);
  assert.equal((await getOrderPaymentMethods(identity, 'return-b-1', {}, 'btc')).btc, secondOrder.btc);
});

test('a damaged allocator head cannot issue an invalid or repeated Bitcoin index', async () => {
  const owner = 'e'.repeat(64);
  const descriptor = 'a'.repeat(64);
  await initializeBitcoinDescriptor({ owner, descriptor, explicitlyNew: true });
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('cipher-commerce-wallet-allocator-v1', 3);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const headId = `${owner.length}:${owner}|${descriptor.length}:${descriptor}`;
  await new Promise((resolve, reject) => {
    const tx = database.transaction('heads', 'readwrite');
    const store = tx.objectStore('heads');
    const request = store.get(headId);
    request.onsuccess = () => { request.result.nextIndex = 0; store.put(request.result); };
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
  database.close();
  await assert.rejects(() => reserveBitcoinIndex({ owner, descriptor, orderId: 'damaged-head-order' }), {
    code: 'WALLET_ALLOCATION_RECOVERY_REQUIRED',
  });
});

test('legacy abbreviated-scope wallet settings migrate intact with existing order addresses', async () => {
  const sk = new Uint8Array(32).fill(35);
  const identity = { sk, pk: getPublicKey(sk) };
  const fullKey = `cipher_${identity.pk}_advanced_vendor_payment_keys`;
  const legacyKey = `cipher_${identity.pk.slice(0, 8)}_advanced_vendor_payment_keys`;
  globalThis.localStorage = memoryStorage({ cipher_active_pubkey: identity.pk });
  resetScopeMigration();
  const xpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(36)).derive("m/84'/0'/0'").publicExtendedKey;
  await saveVendorPaymentConfig(identity, { btcXpub: xpub, btcNetwork: 'bcrt' });
  const original = await getOrderPaymentMethods(identity, 'legacy-order', {}, 'btc');
  const encrypted = localStorage.getItem(fullKey);
  localStorage.removeItem(fullKey);
  localStorage.setItem(legacyKey, encrypted);
  resetScopeMigration();
  assert.deepEqual(await loadVendorPaymentConfig(identity), { btcXpub: xpub, xmrPrivateViewKey: '', btcNetwork: 'bcrt' });
  assert.equal(localStorage.getItem(fullKey), encrypted);
  assert.equal(localStorage.getItem(legacyKey), null);
  assert.equal((await getOrderPaymentMethods(identity, 'legacy-order', {}, 'btc')).btc, original.btc);
});

test('ambiguous abbreviated-scope wallet history fails closed without overwriting it', async () => {
  const sk = new Uint8Array(32).fill(37);
  const identity = { sk, pk: getPublicKey(sk) };
  const prefix = identity.pk.slice(0, 8);
  const legacyKey = `cipher_${prefix}_advanced_vendor_payment_keys`;
  const legacyEnvelope = JSON.stringify({ preserved: 'unassigned legacy ciphertext' });
  globalThis.localStorage = memoryStorage({
    cipher_active_pubkey: identity.pk,
    cipher_vaults: JSON.stringify({ [identity.pk]: {}, [`${prefix}${'f'.repeat(56)}`]: {} }),
    [legacyKey]: legacyEnvelope,
  });
  resetScopeMigration();
  await assert.rejects(() => loadVendorPaymentConfig(identity), { code: 'WALLET_SETTINGS_RECOVERY_REQUIRED' });
  assert.equal(localStorage.getItem(legacyKey), legacyEnvelope);
  assert.equal(localStorage.getItem(`cipher_${identity.pk}_advanced_vendor_payment_keys`), null);
});

test('an account switch during settings read aborts before writing into the new account scope', async () => {
  const ownerSk = new Uint8Array(32).fill(22);
  const identity = { sk: ownerSk, pk: getPublicKey(ownerSk) };
  const other = getPublicKey(new Uint8Array(32).fill(23));
  const ownerKey = `cipher_${identity.pk}_advanced_vendor_payment_keys`;
  const otherKey = `cipher_${other}_advanced_vendor_payment_keys`;
  const storage = memoryStorage({ cipher_active_pubkey: identity.pk, [otherKey]: 'sentinel' });
  globalThis.localStorage = storage;
  const get = storage.getItem;
  let switched = false;
  storage.getItem = (key) => {
    const value = get(key);
    if (key === ownerKey && !switched) { switched = true; storage.setItem('cipher_active_pubkey', other); }
    return value;
  };
  await assert.rejects(() => getOrderPaymentMethods(identity, 'switch-order', {}, 'btc'), { code: 'WALLET_ACCOUNT_CHANGED' });
  assert.equal(get(otherKey), 'sentinel');
});

test('an A-to-B-to-A session change invalidates an operation even when the active owner is A again', async () => {
  const sk = new Uint8Array(32).fill(30);
  const identity = { sk, pk: getPublicKey(sk) };
  const key = `cipher_${identity.pk}_advanced_vendor_payment_keys`;
  const storage = memoryStorage({ cipher_active_pubkey: identity.pk, cipher_identity_session_generation: 'session-one' });
  globalThis.localStorage = storage;
  const get = storage.getItem;
  let changed = false;
  storage.getItem = (name) => {
    const value = get(name);
    if (name === key && !changed) { changed = true; storage.setItem('cipher_identity_session_generation', 'session-three'); }
    return value;
  };
  await assert.rejects(() => getOrderPaymentMethods(identity, 'stale-session-order', {}, 'btc'), { code: 'WALLET_SESSION_CHANGED' });
});

test('a retired R5 security context holds wallet allocation even if the owner key is unchanged', async () => {
  const sk = new Uint8Array(32).fill(42);
  const identity = { sk, pk: getPublicKey(sk) };
  let current = true;
  identity.securityFence = {
    context: { owner: identity.pk, incarnation: 'wallet-test-incarnation-0001' },
    assertCurrent() {
      if (!current) throw Object.assign(new Error('The account security context has expired.'), { code: 'SECURITY_CONTEXT_EXPIRED' });
    },
  };
  const storage = memoryStorage({ cipher_active_pubkey: identity.pk });
  globalThis.localStorage = storage;
  const xpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(43)).derive("m/84'/0'/0'").publicExtendedKey;
  await saveVendorPaymentConfig(identity, { btcXpub: xpub, btcNetwork: 'bcrt' });
  const settingsKey = `cipher_${identity.pk}_advanced_vendor_payment_keys`;
  const get = storage.getItem;
  let retired = false;
  storage.getItem = (key) => {
    const value = get(key);
    if (key === settingsKey && !retired) { retired = true; current = false; }
    return value;
  };
  await assert.rejects(
    () => getOrderPaymentMethods(identity, 'retired-r5-order', {}, 'btc'),
    { code: 'SECURITY_CONTEXT_EXPIRED' },
  );
  const descriptor = await descriptorId(xpub, 'bcrt');
  const next = await reserveBitcoinIndex({ owner: identity.pk, descriptor, orderId: 'next-live-operation' });
  assert.equal(next.index, 1, 'the stale operation did not reserve an address index');
});

test('retiring an allocator context fences writes and a replacement incarnation resumes without skipping an index', async () => {
  const owner = getPublicKey(new Uint8Array(32).fill(44));
  const descriptor = 'allocator-context-retirement-fixture';
  const firstContext = { owner, incarnation: 'allocator-incarnation-first-0001' };
  const firstFence = { context: firstContext, assertCurrent() {} };
  await activateBitcoinAllocationContext(firstFence);
  await initializeBitcoinDescriptor({ owner, descriptor, explicitlyNew: true, securityFence: firstFence });

  const retired = await retireBitcoinAllocationContext(firstContext);
  assert.equal(retired.retired, true);
  await assert.rejects(
    () => reserveBitcoinIndex({ owner, descriptor, orderId: 'held-order', securityFence: firstFence }),
    { code: 'SECURITY_CONTEXT_EXPIRED' },
  );

  const replacementFence = {
    context: { owner, incarnation: 'allocator-incarnation-recovery-0002' },
    assertCurrent() {},
  };
  await activateBitcoinAllocationContext(replacementFence);
  const reservation = await reserveBitcoinIndex({ owner, descriptor, orderId: 'replacement-order', securityFence: replacementFence });
  assert.equal(reservation.index, 1, 'the retired operation did not consume an allocation index');
});

test('one transfer speaks for one order', () => {
  let ledger = markConsumed({}, { currency: 'btc', txid: 'AB', orderId: 'o1', address: 'bc1qa', at: 100 });
  // The txid is key-lowercased, so a replay in any case is still spoken for.
  assert.equal(txidSpokenFor(ledger, { currency: 'btc', txid: 'ab', orderId: 'o1' }), null);
  assert.deepEqual(txidSpokenFor(ledger, { currency: 'btc', txid: 'ab', orderId: 'o2' }), { orderId: 'o1', address: 'bc1qa', at: 100 });
  // The address it landed on is spoken for on other orders too.
  assert.equal(addressSpokenFor(ledger, { address: 'bc1qa', orderId: 'o2' })?.orderId, 'o1');
  assert.equal(addressSpokenFor(ledger, { address: 'bc1qa', orderId: 'o1' }), null);
  // A different coin is a different ledger line.
  assert.equal(txidSpokenFor(ledger, { currency: 'xmr', txid: 'ab', orderId: 'o2' }), null);
  assert.equal(txidSpokenFor(null, { currency: 'btc', txid: 'ab', orderId: 'o2' }), null);
  ledger = markConsumed(ledger, { currency: 'xmr', txid: 'x', orderId: 'o2', address: '8sub', at: 200 });
  assert.equal(Object.keys(ledger).length, 2);
  // A copy comes back; the caller's ledger is never mutated in place.
  assert.deepEqual(Object.keys(markConsumed(ledger, { currency: 'btc', txid: 'cd', orderId: 'o3' })).length, 3);
});

// readConsumedLedger must tell absent, legacy and corrupt apart: a default of
// "nothing recorded" would confirm a payment twice.
test('a ledger that cannot be read confirms nothing, and absent or legacy reads fine', () => {
  globalThis.localStorage = memoryStorage({ cipher_active_pubkey: vendor.pk });
  resetScopeMigration();
  const scope = `cipher_${vendor.pk}_consumed_txids`;
  // No ledger yet — nothing recorded, and that is fine.
  assert.deepEqual(readConsumedLedger(), { ok: true, ledger: {} });
  // The current build's envelope.
  localStorage.setItem(scope, JSON.stringify({ v: 1, entries: markConsumed({}, { currency: 'btc', txid: 'ab', orderId: 'o1', address: 'bc1qa' }) }));
  const enveloped = readConsumedLedger();
  assert.equal(enveloped.ok, true);
  assert.equal(txidSpokenFor(enveloped.ledger, { currency: 'btc', txid: 'ab', orderId: 'o2' })?.orderId, 'o1');
  // A build before the envelope wrote a plain map.
  localStorage.setItem(scope, JSON.stringify({ 'btc:ab': { orderId: 'o1', address: 'bc1qa', at: 100 } }));
  const legacy = readConsumedLedger();
  assert.equal(legacy.ok, true);
  assert.equal(legacy.ledger['btc:ab'].orderId, 'o1');
  // Envelope lies: v differs, or entries are missing or not a map.
  for (const broken of [
    JSON.stringify({ v: 2, entries: {} }),
    JSON.stringify({ v: 1 }),
    JSON.stringify({ v: 1, entries: [1, 2] }),
    'not json at all',
    JSON.stringify([1, 2, 3]),
    'null',
    '42',
  ]) {
    localStorage.setItem(scope, broken);
    assert.equal(readConsumedLedger().ok, false, broken);
  }
});


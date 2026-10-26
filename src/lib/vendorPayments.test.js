import assert from 'node:assert/strict';
import test from 'node:test';
import { HDKey } from '@scure/bip32';
import {
  addressSpokenFor,
  deriveBitcoinAddress,
  getOrderPaymentMethods,
  markConsumed,
  readPaymentAddresses,
  savePaymentAddresses,
  saveVendorPaymentConfig,
  txidSpokenFor,
} from './vendorPayments.js';

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
  savePaymentAddresses({ btc: ' bc1qaccounta ', xmr: '' });
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

test('a single-account device adopts its old device-wide address once', () => {
  const only = 'cccccccc' + '3'.repeat(56);
  globalThis.localStorage = memoryStorage({
    cipher_vaults: JSON.stringify({ [only]: {} }),
    cipher_active_pubkey: only,
    cipher_xmr: '8legacy',
  });
  assert.deepEqual(readPaymentAddresses(), { btc: '', xmr: '8legacy' });
  assert.equal(localStorage.getItem('cipher_xmr'), null);
  assert.equal(localStorage.getItem('cipher_cccccccc_xmr_address'), '"8legacy"');
});

const vendor = { pk: 'dddddddd' + '4'.repeat(56), sk: new Uint8Array(32).fill(7) };
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

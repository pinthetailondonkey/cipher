import assert from 'node:assert/strict';
import test from 'node:test';
import { HDKey } from '@scure/bip32';
import { deriveBitcoinAddress, readPaymentAddresses, savePaymentAddresses } from './vendorPayments.js';

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

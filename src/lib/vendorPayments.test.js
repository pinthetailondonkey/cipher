import assert from 'node:assert/strict';
import test from 'node:test';
import { HDKey } from '@scure/bip32';
import { deriveBitcoinAddress } from './vendorPayments.js';

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

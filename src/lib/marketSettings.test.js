// The fee destination setting, attacked from the operator's paste box.
//
// What matters:
//   - a real Bitcoin address becomes exactly one output script;
//   - an xpub rotates across the 1..20 gap, and the SAME order always lands
//     on the SAME address, because both parties derive it without talking;
//   - a Monero address is refused with its own words, and a seed or private
//     key is refused before it can be stored;
//   - a bad paste writes nothing, and an unreadable stored row reads as
//     unset, so a release never pays a value this device cannot parse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bech32 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import {
  FEE_ADDRESS_KEY,
  FEE_ROTATION_FIRST,
  FEE_ROTATION_LAST,
  feeDestination,
  feeIndexFor,
  feeScriptFor,
  parseFeeSetting,
  readFeeSetting,
  saveFeeSetting,
} from './marketSettings.js';
import { deriveBitcoinAddress } from './vendorPayments.js';
import { scriptToHex } from './escrowScript.js';

// A test address, not anyone's real one: 20 deterministic bytes.
const PROGRAM = Uint8Array.from({ length: 20 }, (_, i) => i + 1);
const TEST_ADDRESS = bech32.encode('bc', [0, ...bech32.toWords(PROGRAM)]);
const XPUB = HDKey.fromMasterSeed(new Uint8Array(32).fill(7)).publicExtendedKey;

class FakeSettings {
  rows = new Map();
  async get(key) {
    return this.rows.get(key);
  }
  async put(row) {
    this.rows.set(row.key, row);
  }
}

test('a pasted address becomes exactly one witness-v0 output script', () => {
  const destination = feeDestination(TEST_ADDRESS);
  assert.equal(destination.kind, 'address');
  assert.equal(destination.scriptHex, `0014${scriptToHex(PROGRAM)}`);
  assert.equal(destination.address, TEST_ADDRESS.toLowerCase());
});

test('a Monero address is refused, and says why', () => {
  const xmr = '49bs91Ck67kYZn2FnjQnbQ3xYxKJuGtjb1vQ6bFTH5oTGAMt6Ljgn9L6tdirFRyLf4fnCo4pgs86fUSvEVwHfct8PKVcSFP';
  assert.throws(() => feeDestination(xmr), /Monero address.*escrow pays Bitcoin.*bc1/);
});

test('a seed phrase never reaches the setting', async () => {
  const seed = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  await assert.rejects(parseFeeSetting(seed), /seed/);
  await assert.rejects(parseFeeSetting(`${seed} extra words here to be longer than twelve`), /seed/);
});

test('a bad paste is refused and nothing is written', async () => {
  const table = new FakeSettings();
  for (const bad of ['', '   ', 'bc1notanaddress', 'not an address', TEST_ADDRESS.replace('bc1', 'tb1')]) {
    assert.throws(() => feeDestination(bad));
    await assert.rejects(saveFeeSetting(bad, table));
  }
  assert.equal(table.rows.size, 0, 'a refused paste leaves no row');
});

test('a saved destination round-trips and can be changed', async () => {
  const table = new FakeSettings();
  assert.equal(await readFeeSetting(table), null, 'unset reads as unset');
  const first = await saveFeeSetting(TEST_ADDRESS, table);
  assert.equal(table.rows.size, 1);
  assert.equal((await readFeeSetting(table)).scriptHex, first.scriptHex);

  const other = bech32.encode('bc', [0, ...bech32.toWords(Uint8Array.from({ length: 20 }, (_, i) => 200 - i))]);
  await saveFeeSetting(other, table);
  assert.equal(table.rows.size, 1, 'one setting, replaced');
  assert.equal((await readFeeSetting(table)).address, other.toLowerCase());
  assert.equal(table.rows.get(FEE_ADDRESS_KEY).kind, 'address');
});

test('an unreadable stored row reads as unset, never as a payout', async () => {
  const table = new FakeSettings();
  table.rows.set(FEE_ADDRESS_KEY, { key: FEE_ADDRESS_KEY, value: 'garbage' });
  assert.equal(await readFeeSetting(table), null);
  table.rows.set(FEE_ADDRESS_KEY, { key: FEE_ADDRESS_KEY, value: '' });
  assert.equal(await readFeeSetting(table), null);
  table.rows.set(FEE_ADDRESS_KEY, { key: FEE_ADDRESS_KEY, value: 42 });
  assert.equal(await readFeeSetting(table), null);
});

test('an xpub rotates inside 1..20, and the order id picks the slot', async () => {
  const setting = await parseFeeSetting(XPUB);
  assert.equal(setting.kind, 'xpub');
  const seen = new Set();
  for (const orderId of ['order-a', 'order-b', 'order-c', 'order-d', 'order-e']) {
    const index = feeIndexFor(orderId);
    assert.ok(index >= FEE_ROTATION_FIRST && index <= FEE_ROTATION_LAST, `${orderId} -> ${index}`);
    const script = await feeScriptFor(setting, orderId);
    assert.match(script, /^0014[0-9a-f]{40}$/);
    // the script is the address the vendor payment code derives
    const address = await deriveBitcoinAddress(XPUB, index, 'bc');
    assert.equal(script, `0014${scriptToHex(bech32.fromWords(bech32.decode(address).words.slice(1)))}`);
    seen.add(script);
  }
  assert.ok(seen.size > 1, 'five orders do not all pay one address');
});

test('the same order always lands on the same fee address', async () => {
  const setting = await parseFeeSetting(XPUB);
  const a = await feeScriptFor(setting, 'order-42');
  const b = await feeScriptFor(setting, 'order-42');
  assert.equal(a, b, 'both parties derive one destination without talking');
  assert.equal(feeIndexFor('order-42'), feeIndexFor('order-42'));
});

test('an xpub is saved as an xpub, and a fixed address stays fixed', async () => {
  const table = new FakeSettings();
  await saveFeeSetting(XPUB, table);
  assert.equal(table.rows.get(FEE_ADDRESS_KEY).kind, 'xpub');
  assert.equal((await readFeeSetting(table)).kind, 'xpub');
  // a fixed address ignores the order entirely
  const fixed = await parseFeeSetting(TEST_ADDRESS);
  assert.equal(await feeScriptFor(fixed, 'order-a'), await feeScriptFor(fixed, 'order-b'));
});

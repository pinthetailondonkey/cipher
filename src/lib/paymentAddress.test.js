import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkPaymentAddress, paymentAddressesProblem } from './paymentAddress.js';

// Published Bitcoin vectors: BIP173 (bech32), BIP350 (bech32m) and the
// classic base58check addresses. Every one is checked by the string's own
// checksum, so the check is local string math — no explorer is asked.
const BTC_P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const BTC_P2WSH = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
const BTC_P2TR = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const BTC_P2PKH = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const BTC_P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const BTC_TESTNET = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
// A v1 witness encoded with the bech32 checksum, and a v0 witness encoded
// with bech32m: both are refused by BIP350, and both have a good checksum
// for the wrong variant.
const BTC_V1_AS_BECH32 = 'bc1pqyqszqgpqyqszqgpqyqszqgpqyqszqgp0hg7y6';
const BTC_V0_AS_BECH32M = 'bc1qqyqszqgpqyqszqgpqyqszqgpqyqszqgp340evn';

// Published Monero vectors: a standard address (prefix 0x12) and a
// subaddress (prefix 0x2a). The integrated address is built from the same
// keys with prefix 0x13 and an 8-byte payment id, checksum recomputed.
const XMR_STANDARD = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const XMR_SUBADDRESS = '888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H';
const XMR_INTEGRATED = '4DrvGduF3ynBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVPkNUtnN5hPM13TZaa4';
const XMR_TESTNET = '9uhnk5k1j5NBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGRySiok';
const XMR_BAD_CHECKSUM = `${XMR_STANDARD.slice(0, 94)}B`;

test('a Bitcoin address that carries its own checksum is accepted', () => {
  for (const address of [BTC_P2WPKH, BTC_P2WSH, BTC_P2TR, BTC_P2PKH, BTC_P2SH]) {
    const result = checkPaymentAddress('BTC', address, { network: 'bc' });
    assert.equal(result.ok, true, `${address} should be valid: ${result.message || ''}`);
  }
  // All-caps is the same bech32 string; the checksum still verifies.
  assert.equal(checkPaymentAddress('BTC', BTC_P2WPKH.toUpperCase(), { network: 'bc' }).ok, true);
  // Surrounding whitespace from a paste is trimmed, not refused.
  assert.equal(checkPaymentAddress('BTC', `  ${BTC_P2WPKH}\n`, { network: 'bc' }).ok, true);
});

test('one changed character in a Bitcoin address is refused', () => {
  const corrupted = `${BTC_P2WPKH.slice(0, -1)}5`;
  const result = checkPaymentAddress('BTC', corrupted, { network: 'bc' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'checksum');
});

test('a Bitcoin address that mixes capitals and small letters is refused', () => {
  const mixed = `bc1Q${BTC_P2WPKH.slice(4)}`;
  assert.equal(checkPaymentAddress('BTC', mixed, { network: 'bc' }).ok, false);
});

test('a witness program with the wrong checksum variant is refused', () => {
  assert.equal(checkPaymentAddress('BTC', BTC_V1_AS_BECH32, { network: 'bc' }).ok, false);
  assert.equal(checkPaymentAddress('BTC', BTC_V0_AS_BECH32M, { network: 'bc' }).ok, false);
});

test('a Bitcoin address on the other network is named, not accepted', () => {
  const testnet = checkPaymentAddress('BTC', BTC_TESTNET, { network: 'bc' });
  assert.equal(testnet.ok, false);
  assert.equal(testnet.reason, 'network');
  const legacyTestnet = checkPaymentAddress('BTC', 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', { network: 'bc' });
  assert.equal(legacyTestnet.ok, false);
  assert.equal(legacyTestnet.reason, 'network');
  // The same string is valid when the matching network is named.
  assert.equal(checkPaymentAddress('BTC', BTC_TESTNET, { network: 'tb' }).ok, true);
});

test('a Monero address is checked by its own keccak checksum', () => {
  for (const [address, kind] of [[XMR_STANDARD, 'standard'], [XMR_SUBADDRESS, 'subaddress'], [XMR_INTEGRATED, 'integrated']]) {
    const result = checkPaymentAddress('XMR', address);
    assert.equal(result.ok, true, `${address} should be valid: ${result.message || ''}`);
    assert.equal(result.kind, kind);
  }
});

test('a Monero address with one changed character, a short body or the wrong network is refused', () => {
  const corrupted = checkPaymentAddress('XMR', XMR_BAD_CHECKSUM);
  assert.equal(corrupted.ok, false);
  assert.equal(corrupted.reason, 'checksum');
  assert.equal(checkPaymentAddress('XMR', XMR_STANDARD.slice(0, 94)).ok, false);
  assert.equal(checkPaymentAddress('XMR', XMR_INTEGRATED.slice(0, 105)).ok, false);
  const testnet = checkPaymentAddress('XMR', XMR_TESTNET);
  assert.equal(testnet.ok, false);
  assert.equal(testnet.reason, 'network');
  // A character outside the Monero alphabet cannot decode at all.
  assert.equal(checkPaymentAddress('XMR', `${XMR_STANDARD.slice(0, 94)}0`).ok, false);
});

test('an empty or whitespace-only address is refused for both coins', () => {
  for (const currency of ['BTC', 'XMR']) {
    const empty = checkPaymentAddress(currency, '');
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, 'empty');
    assert.equal(checkPaymentAddress(currency, '   ').ok, false);
    assert.equal(checkPaymentAddress(currency, null).ok, false);
    assert.equal(checkPaymentAddress(currency, 'not an address').ok, false);
  }
});

test('the pair check names the first bad address and passes a good pair', () => {
  assert.equal(paymentAddressesProblem({ btc: BTC_P2WPKH, xmr: '' }), null);
  assert.equal(paymentAddressesProblem({ btc: '', xmr: XMR_STANDARD }), null);
  const problem = paymentAddressesProblem({ btc: 'garbage', xmr: XMR_STANDARD });
  assert.equal(problem.currency, 'BTC');
  assert.match(problem.message, /Bitcoin/);
  const xmrProblem = paymentAddressesProblem({ btc: BTC_P2WPKH, xmr: 'garbage' });
  assert.equal(xmrProblem.currency, 'XMR');
});

// Source contract: a checker nobody calls is not a check. Each edge that can
// put an address in front of a buyer must reach this module.
test('every surface that can issue a payment address calls the checker', () => {
  const surfaces = [
    ['../lib/vendorPayments.js', /from '\.\/paymentAddress'/],
    ['../lib/vendorPayments.js', /checkPaymentAddress\(/],
    ['../features/chat/useCommerce.js', /from '\.\.\/\.\.\/lib\/paymentAddress'/],
    ['../features/chat/useCommerce.js', /paymentAddressesProblem\(/],
  ];
  for (const [path, pattern] of surfaces) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, pattern, `${path} does not reach the checker`);
  }
});

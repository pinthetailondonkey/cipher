import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEscrowAcceptance,
  escrowActionsFor,
  escrowForCard,
  escrowPaymentRow,
  escrowRequestSlot,
  escrowRowsFor,
  newEscrowSalt,
  orderEscrowKey,
} from './escrowActions.js';
import { assembleOrderScript, decodeOrderScript, hexToScript, scriptToHex } from './escrowScript.js';
import { quoteEscrow, MIN_ORDER_SATS } from './escrowFsm.js';
import { escrowAddress } from './escrowPsbt.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

// The card layer, attacked the way a buyer reads a vendor's card and a
// vendor reads a buyer's request: nothing is adopted off the wire that
// this device cannot redo itself. The tests share the membrane test's
// shape: keys, price, a quote, then the forgery.

const PRICE = 50_000_000n; // 0.5 BTC
const ACCOUNT_SECRET = secp256k1.utils.randomSecretKey();
const ACCOUNT_SECRET_2 = secp256k1.utils.randomSecretKey();
const ISSUED_AT = 1_700_000_000;

const PUB_B = secp256k1.getPublicKey(ACCOUNT_SECRET, true);
const PUB_B_HEX = scriptToHex(PUB_B);
const PUB_V_HEX = scriptToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));
const PUB_STRANGER_HEX = scriptToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));

function acceptance({ priceSats = PRICE, vendorPubHex = PUB_V_HEX, buyerPubHex = PUB_B_HEX, delayBlocks } = {}) {
  return buildEscrowAcceptance({ priceSats, vendorPubHex, buyerPubHex, issuedAt: ISSUED_AT, ...(delayBlocks ? { delayBlocks } : {}) });
}

const fakeMessages = () => [];
const requestCard = () => ({
  id: 'order-1',
  isSender: false,
  pubkey: 'buyer-pk',
  data: { type: 'order_request', escrowSalt: newEscrowSalt(), escrowPubKey: PUB_B_HEX, product: { title: 'Pack', price: '0.5', currency: 'btc' } },
});

test('the per-order key derives from the account secret and the order salt', async () => {
  const salt = newEscrowSalt();
  const a = await orderEscrowKey(ACCOUNT_SECRET, salt);
  const b = await orderEscrowKey(ACCOUNT_SECRET, salt);
  const c = await orderEscrowKey(ACCOUNT_SECRET_2, salt);
  assert.equal(a.publicKeyHex, b.publicKeyHex, 'same secret, same slot, same key');
  assert.notEqual(a.publicKeyHex, c.publicKeyHex, 'a different account never lands on the slot key');
  // and the key actually signs: it is a real secp256k1 key
  const digest = new Uint8Array(32).fill(7);
  const sig = secp256k1.sign(digest, a.privateKeyBytes, { prehash: false, format: 'der' });
  assert.equal(secp256k1.verify(sig, digest, hexToScript(a.publicKeyHex), { format: 'der', prehash: false }), true);
});

test('an acceptance carries the whole money table, recomputable from the script alone', () => {
  const { escrow, patch } = acceptance();
  const q = quoteEscrow(PRICE);
  assert.equal(escrow.priceSats, '50000000');
  assert.equal(escrow.buyerFeeSats, q.buyerFeeSats.toString());
  assert.equal(escrow.vendorFeeSats, q.vendorFeeSats.toString());
  assert.equal(escrow.depositSats, q.depositSats.toString());
  const decoded = decodeOrderScript(hexToScript(escrow.scriptHex));
  assert.notEqual(decoded, null);
  assert.equal(scriptToHex(decoded.vendorPubKey), PUB_V_HEX);
  assert.equal(scriptToHex(decoded.buyerPubKey), PUB_B_HEX);
  assert.equal(escrow.address, escrowAddress(hexToScript(escrow.scriptHex)));
  assert.equal(patch.status, 'accepted');
  assert.equal(patch.escrow, escrow);
});

test('a received quote is adopted only when this device redoes the math', () => {
  const { escrow } = acceptance();
  const quote = escrowForCard({ escrow });
  assert.notEqual(quote, null);
  assert.equal(quote.priceSats, PRICE);
  assert.equal(quote.depositSats, quoteEscrow(PRICE).depositSats);
  // a fee the vendor hand-tuned reads back as no escrow at all
  const skimmed = escrowForCard({ escrow: { ...escrow, buyerFeeSats: '1' } });
  assert.equal(skimmed, null, 'a fee off the FSM never renders');
  // a price lie, the same
  assert.equal(escrowForCard({ escrow: { ...escrow, priceSats: '1000' } }), null);
  // a lying timer
  assert.equal(escrowForCard({ escrow: { ...escrow, delayBlocks: 300 } }), null);
  // a swapped address (a real-looking bech32 address of a DIFFERENT script)
  const otherScript = assembleOrderScript({
    vendorPubKey: hexToScript(PUB_STRANGER_HEX), buyerPubKey: hexToScript(PUB_B_HEX), delayBlocks: 2880,
  });
  assert.equal(escrowForCard({ escrow: { ...escrow, address: escrowAddress(otherScript) } }), null);
  // a script that is not the escrow shape
  assert.equal(escrowForCard({ escrow: { ...escrow, scriptHex: '00' } }), null);
});

test('a dust order never accepts with escrow, at the FSM floor', () => {
  assert.throws(() => acceptance({ priceSats: MIN_ORDER_SATS - 1n }), /dust|BTC or more/);
  // and the reader refuses the same card
  assert.equal(escrowForCard({ escrow: { ...acceptance({ priceSats: MIN_ORDER_SATS }).escrow, priceSats: '39999' } }), null);
});

test('the accept-with-escrow button: only the vendor, only pending, only a slotted BTC order', () => {
  const card = requestCard();
  // the vendor sees the button on a pending, slotted, BTC-priced order
  const vendor = escrowActionsFor(card, fakeMessages(), 'vendor-pk');
  assert.deepEqual(vendor.map((a) => a.action), ['accept_with_escrow']);
  assert.equal(vendor[0].label, 'Accept with escrow');
  // the buyer never sees it on their own request
  assert.deepEqual(escrowActionsFor({ ...card, isSender: true }, fakeMessages(), 'buyer-pk'), []);
  // no slot, no button
  assert.deepEqual(
    escrowActionsFor({ ...card, data: { ...card.data, escrowSalt: undefined } }, fakeMessages(), 'vendor-pk'),
    [],
  );
  // not a BTC price, no button
  assert.deepEqual(
    escrowActionsFor({ ...card, data: { ...card.data, product: { title: 'Pack', price: '5', currency: 'usd' } } }, fakeMessages(), 'vendor-pk'),
    [],
  );
  // a price the FSM refuses (dust), no button
  assert.deepEqual(
    escrowActionsFor({ ...card, data: { ...card.data, product: { title: 'Pack', price: '0.0001', currency: 'btc' } } }, fakeMessages(), 'vendor-pk'),
    [],
  );
  // an accepted order offers nothing more this phase
  assert.deepEqual(
    escrowActionsFor({ ...card, data: { ...card.data, status: 'accepted' } }, fakeMessages(), 'vendor-pk'),
    [],
  );
});

test('the buyer pays the escrow address only when the refund key is their own slot', () => {
  const { escrow } = acceptance(); // built against the buyer's slot key
  const card = requestCard();
  const accepted = { ...card, data: { ...card.data, status: 'accepted', escrow } };
  // the buyer's own request named slot key PUB_B_HEX; the script's buyer
  // key IS that key, so the deposit row renders
  const rows = escrowRowsFor(accepted, [card], accepted.data);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].currency, 'BTC');
  assert.equal(rows[0].address, escrow.address);
  assert.equal(rows[0].amount, '0.5125'); // deposit = 50,000,000 + 1,250,000 sats
  assert.equal(rows[0].uri, `bitcoin:${escrow.address}?amount=0.5125`);
  // the SAME quote over a request that named a different slot key renders
  // NOTHING: the refund branch would pay a stranger's key
  const otherCard = { ...card, data: { ...card.data, escrowPubKey: PUB_STRANGER_HEX } };
  assert.deepEqual(escrowRowsFor(accepted, [otherCard], accepted.data), []);
  // no request card in the chat, no row either
  assert.deepEqual(escrowRowsFor(accepted, [], accepted.data), []);
  // the vendor's own card shows its own quote (it holds the script)
  assert.equal(escrowRowsFor({ ...accepted, isSender: true }, [], accepted.data).length, 1);
});

test('the payment row carries the deposit, never the price alone', () => {
  const q = quoteEscrow(PRICE);
  const row = escrowPaymentRow({
    address: 'bc1qtest0000000000000000000000000000000000000000000000000aaaaaa',
    depositSats: q.depositSats,
  });
  assert.equal(row.amount, '0.5125'); // 51,250,000 sats, exactly
});

test('a fresh slot per order: two orders, two salts, two keys', async () => {
  const one = await escrowRequestSlot(ACCOUNT_SECRET);
  const two = await escrowRequestSlot(ACCOUNT_SECRET);
  assert.notEqual(one.salt, two.salt);
  assert.notEqual(one.publicKeyHex, two.publicKeyHex);
  // the salt is public data: 32 hex bytes, no secret in it
  assert.equal(/^[0-9a-f]{64}$/.test(one.salt), true);
});

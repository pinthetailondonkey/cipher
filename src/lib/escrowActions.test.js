import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildEscrowAcceptance,
  CLOCK_CLAIM_LINE,
  CLOCK_CLAIM_TITLE,
  deliveryNonceOf,
  escrowActionsFor,
  escrowForCard,
  escrowPaymentRow,
  escrowRequestSlot,
  escrowRowsFor,
  issuedEscrowPatch,
  newDeliveryNonce,
  newEscrowSalt,
  orderEscrowKey,
  overtHashHexOf,
  OVERT_REFUND_LINE,
  OVERT_REFUND_TITLE,
} from './escrowActions.js';
import { assembleOrderScript, decodeOrderScript, hexToScript, scriptToHex } from './escrowScript.js';
import { sha256 } from '@noble/hashes/sha2.js';
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

function acceptance({ priceSats = PRICE, vendorPubHex = PUB_V_HEX, buyerPubHex = PUB_B_HEX, delayBlocks, overtHashHex = overtHashHexOf(newDeliveryNonce()) } = {}) {
  return buildEscrowAcceptance({ priceSats, vendorPubHex, buyerPubHex, issuedAt: ISSUED_AT, overtHashHex, ...(delayBlocks ? { delayBlocks } : {}) });
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

// Round-2 card, vector 9: the Dead Drop commitment is per-order by
// construction — a fresh crypto-random nonce at acceptance, its sha256
// in the script, the nonce itself never crossing the wire.
test('the delivery nonce is per-order crypto-random and stays off the wire', () => {
  const a = newDeliveryNonce();
  const b = newDeliveryNonce();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  // the spoken commitment is sha256 of the nonce, and it round-trips
  const spoken = overtHashHexOf(a);
  assert.equal(spoken, scriptToHex(sha256(hexToScript(a))));
  assert.throws(() => overtHashHexOf('zz'), /32-byte/);
  assert.equal(deliveryNonceOf({ deliveryNonceHex: a }), a);
  assert.equal(deliveryNonceOf({ deliveryNonceHex: 'short' }), null);
  assert.equal(deliveryNonceOf({}), null);
});

test('every escrow acceptance is a Dead Drop box: the script embeds the spoken commitment', () => {
  const nonce = newDeliveryNonce();
  const accepted = acceptance({ overtHashHex: overtHashHexOf(nonce) });
  const escrow = accepted.escrow;
  assert.equal(escrow.overtHashHex, overtHashHexOf(nonce));
  const decoded = decodeOrderScript(hexToScript(escrow.scriptHex));
  assert.equal(scriptToHex(decoded.overtHash), escrow.overtHashHex);
  // and the acceptance is a Clock Box: the day-20 vendor claim rides
  // the same CSV gate as the buyer's refund
  assert.equal(decoded.claimBlocks, escrow.delayBlocks);
  // no commitment, no acceptance — a silent open would strand the dead drop
  assert.throws(() => buildEscrowAcceptance({
    priceSats: PRICE, vendorPubHex: PUB_V_HEX, buyerPubHex: PUB_B_HEX, issuedAt: ISSUED_AT,
  }), /delivery commitment/);
  assert.throws(() => acceptance({ overtHashHex: 'zz'.repeat(32) }), /delivery commitment/);
});

test('the card binds the spoken commitment to the script’s own bytes', () => {
  const quote = escrowForCard({ escrow: acceptance().escrow });
  assert.match(quote.overtHashHex, /^[0-9a-f]{64}$/);
  // a card whose spoken hash disagrees with its embedded hash is not escrow
  assert.equal(escrowForCard({ escrow: { ...acceptance().escrow, overtHashHex: 'f'.repeat(64) } }), null);
  assert.equal(escrowForCard({ escrow: { ...acceptance().escrow, overtHashHex: undefined } }), null);
  // an old plain box speaks nothing and reads back with overtHashHex null
  const plain = assembleOrderScript({
    vendorPubKey: hexToScript(PUB_V_HEX), buyerPubKey: hexToScript(PUB_B_HEX), delayBlocks: 2880,
  });
  const plainQuote = escrowForCard({ escrow: {
    ...acceptance().escrow,
    scriptHex: scriptToHex(plain),
    address: escrowAddress(plain),
  } });
  assert.equal(plainQuote.overtHashHex, null);
});

// S5 for escrow, the freeze the direct accept holds: an escrow this
// device issued is frozen on its own patch, and a re-accept serves the
// first one — a fresh nonce on money a buyer may already be funding is
// the paid-then-readdressed scam, and it starts at the freeze.
test('an issued escrow freezes on its card; a corrupt one reads as nothing issued', () => {
  const { escrow, patch } = acceptance();
  // the patch this device wrote freezes whole — quote, address, commitment
  const frozen = issuedEscrowPatch(patch);
  assert.notEqual(frozen, null);
  assert.equal(frozen, patch);
  assert.deepEqual(frozen.escrow, escrow);
  // not accepted yet, nothing issued
  assert.equal(issuedEscrowPatch({ ...patch, status: 'pending' }), null);
  assert.equal(issuedEscrowPatch({}), null);
  assert.equal(issuedEscrowPatch(), null);
  // money state raised past address_issued: still frozen — money may
  // already sit on the first address, that is the point of the freeze
  assert.notEqual(issuedEscrowPatch({ ...patch, paymentState: 'seen' }), null);
  // a hand-broken escrow on an accepted card reads as nothing issued:
  // the quote re-proves itself before anything is served from it
  const broken = { ...patch, escrow: { ...escrow, address: 'bc1qnot--mine----' } };
  assert.equal(issuedEscrowPatch(broken), null);
  // a lying fee or price, the same (escrowForCard refuses hand-tuned fees)
  assert.equal(issuedEscrowPatch({ ...patch, escrow: { ...escrow, priceSats: '1000' } }), null);
});

test('the escrow accept freeze is wired before the mint, reuse never a fresh nonce', () => {
  const commerce = fs.readFileSync(new URL('../features/chat/useCommerce.js', import.meta.url), 'utf8');
  // the freeze read and its reuse path exist
  assert.match(commerce, /const prior = issuedEscrowPatch\(msg\.localPatch\)/);
  // and the freeze read comes BEFORE the mint — the fresh nonce line.
  const prior = commerce.indexOf('const prior = issuedEscrowPatch(msg.localPatch)');
  const freshNonce = commerce.indexOf('const deliveryNonceHex = newDeliveryNonce()');
  assert.notEqual(prior, -1);
  assert.notEqual(freshNonce, -1);
  assert.ok(prior < freshNonce, 'the freeze must be read before a fresh nonce can mint');
  // the reuse path and the mint are different branches: the reuse path
  // sits entirely inside its `if (prior)` block, which never names the
  // nonce call
  const reuseBlock = commerce.slice(prior, commerce.indexOf('}', commerce.indexOf("message: `Accepted with escrow ${NOT_SAVED}`")));
  assert.equal(reuseBlock.includes('newDeliveryNonce()'), false, 'the reuse path mints nothing');
});

test('the vendor’s delivery nonce is written to the local patch, never the wire payload', () => {  // Source law (CLAUDE.md reload rule): the nonce must survive a history
  // fetch, so it is written into the order's local patch via the same
  // updateLocalOrder the acceptance patch already rides. The wire payload
  // is built from acceptance.escrow alone, which never carries it (pinned
  // by the acceptance test above).
  const src = fs.readFileSync(new URL('../features/chat/useCommerce.js', import.meta.url), 'utf8');
  assert.match(src, /const deliveryNonceHex = newDeliveryNonce\(\)/);
  assert.match(src, /overtHashHex: overtHashHexOf\(deliveryNonceHex\)/);
  assert.match(src, /\.\.\.acceptance\.patch,\s*deliveryNonceHex/);
  // the payload that rides sendDM never names the nonce
  const payloadBlock = src.slice(
    src.indexOf("type: 'order_update',\n            orderId: msg.id,"),
    src.indexOf("const result = await sendDM(msg.pubkey, payload);"),
  );
  assert.equal(payloadBlock.includes('deliveryNonceHex'), false, 'the wire payload carries the nonce');
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

// Wiring pins, read off the app source (the way the order action
// coherence test reads it): the request slot and the escrow price
// come off tables, not off the buyer's word. (re-attack round @
// 52cbdab — the first wiring shipped slot.salt off a return that has
// no salt, so requests went out keyless and the dead button leaned
// on the same read; and the quote priced the buyer's typed amount.)
test('the request slot and the escrow price are wired off the right tables', () => {
  const commerce = fs.readFileSync(new URL('../features/chat/useCommerce.js', import.meta.url), 'utf8');
  // the slot is built by escrowRequestSlot — salt AND key from one pair
  assert.match(commerce, /const slot = await escrowRequestSlot\(identity\.sk\)/);
  assert.doesNotMatch(commerce, /orderEscrowKey\(identity\.sk, newEscrowSalt/);
  // the escrow handler prices through acceptanceDemand + the own menu
  const start = commerce.indexOf("if (action === 'accept_with_escrow')");
  assert.notEqual(start, -1, 'the escrow handler moved — re-pin the wiring test');
  const escrowBlock = commerce.slice(start, commerce.indexOf("if (action === 'accept_order'", start));
  assert.match(escrowBlock, /acceptanceDemand\(msg\.data\.product, readOwnMenu\(\), 'btc'\)/);
  assert.doesNotMatch(escrowBlock, /orderCoinAmount\(msg\.data\.product/);
});

// Founder-approved voice lines, verbatim (2026-10-26). These are the
// receipts' honesty law, so the words are pinned the way wiring is:
// an escrow card promises only what escrow proves, and an unfunded
// slotted deal says so before the buyer pays. It proves the vendor
// ASSERTED delivery, never that atoms moved — every future escrow
// surface inherits that line, it does not get softer.
test('the receipts speak the approved honesty lines, verbatim', () => {
  const bubble = fs.readFileSync(new URL('../components/MessageBubble.jsx', import.meta.url), 'utf8');
  assert.match(bubble, /Money comes back if the deal can't be proven — it can't inspect the goods\./);
  assert.match(bubble, /No escrow on this order\. If it goes wrong, the money is gone\./);
});

// Round-2 card, vectors 7 and 8. The overt refund is the vendor's own
// delivery claim; the words that ride it may never upgrade the claim to
// proof, promise a loss is "safe", or imply the app examined anything.
test('the dead drop receipt words are staged, honest as an assertion only', () => {
  assert.equal(OVERT_REFUND_TITLE, 'Returned in full');
  assert.equal(OVERT_REFUND_LINE, 'The vendor said they delivered. The money went home on their word, not an inspection.');
  const action = fs.readFileSync(new URL('./escrowActions.js', import.meta.url), 'utf8');
  const bubble = fs.readFileSync(new URL('../components/MessageBubble.jsx', import.meta.url), 'utf8');
  const literals = (src) => src.match(/'[^'\n]*'/g) ?? [];
  const escrowCopy = [...literals(action), ...literals(bubble)].filter((s) =>
    /escrow|Escrow|Dead Drop|dead drop|delivered|refund|Refund/.test(s)
    && !s.startsWith("'../") && !s.startsWith("'./") && !s.startsWith("'@noble"));
  assert.equal(literals(action).includes(`'${OVERT_REFUND_TITLE}'`), true, 'predicates: the staged words are in the source');
  assert.equal(escrowCopy.includes(`'${OVERT_REFUND_LINE}'`), true, 'predicates: the staged line is in the scanned copy');
  for (const s of escrowCopy) {
    assert.doesNotMatch(s, /verif|confirm|guarantee|\bproof\b/, `escrow copy claimed too much: ${s}`);
  }
});

// The Clock Box receipt: the day-20 claim moves money on silence, and
// silence is not an inspection either. Pinned verbatim, scanned under
// the same honesty ban as the dead drop's words.
test('the clock claim receipt words are staged, honest as silence only', () => {
  assert.equal(CLOCK_CLAIM_TITLE, 'Settled by the clock');
  assert.equal(CLOCK_CLAIM_LINE, 'The buyer went quiet past the timer, so the clock freed the money to the vendor. Silence is not an inspection.');
  const action = fs.readFileSync(new URL('./escrowActions.js', import.meta.url), 'utf8');
  const bubble = fs.readFileSync(new URL('../components/MessageBubble.jsx', import.meta.url), 'utf8');
  const literals = (src) => src.match(/'[^'\n]*'/g) ?? [];
  const escrowCopy = [...literals(action), ...literals(bubble), CLOCK_CLAIM_TITLE, CLOCK_CLAIM_LINE].filter((s) =>
    /escrow|Escrow|Dead Drop|dead drop|delivered|refund|Refund|clock|Clock/.test(s)
    && !s.startsWith("'../") && !s.startsWith("'./") && !s.startsWith("'@noble"));
  assert.equal(escrowCopy.includes(`'${CLOCK_CLAIM_TITLE}'`), true, 'predicates: the staged title is in the scanned copy');
  assert.equal(escrowCopy.includes(`'${CLOCK_CLAIM_LINE}'`), true, 'predicates: the staged line is in the scanned copy');
  for (const s of escrowCopy) {
    assert.doesNotMatch(s, /verif|confirm|guarantee|\bproof\b/, `escrow copy claimed too much: ${s}`);
  }
});

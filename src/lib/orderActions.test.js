import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ORDER_ACTIONS, allowedActionsFor, issuedPaymentMethods, orderActionsFor, orderPaymentDetails, orderRecordForReceipt, orderState, reopenedStatus } from './orderActions.js';
import { ORDER_STATUS, ORDER_STATUSES, RECEIPT_OUTCOMES } from './paymentState.js';
import { signReceipt } from './proofOfTrade.js';

// F7: the payment facts on an order are earned on this device, never asserted
// by the peer. These tests are the attack they shut down: a peer writes
// paymentState 'confirmed'/paymentSeenBy 'watcher' into updates and cards, and
// nothing on the order gives that claim standing.

const hexOf = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const names = (actions) => actions.map((item) => item.action);
const request = (isSender, data = {}) => ({ id: 'order-1', isSender, timestamp: 10, data: { type: 'order_request', status: 'pending', product: { title: 'Tee' }, ...data } });
const update = (id, isSender, status, timestamp, extra = {}) => ({ id, isSender, timestamp, data: { type: 'order_update', orderId: 'order-1', status, ...extra } });

test('every status for both viewers gets exactly the actions in the table', () => {
  const unpaid = { paymentState: 'address_issued', paymentSeenBy: '' };
  const expected = {
    vendor: {
      pending: ['accept_order', 'decline_order'],
      accepted: ['confirm_payment', 'check_chain'],
      paid: ['check_chain'],
      shipped: [],
      completed: [],
      cancelled: [],
      refunded: [],
      disputed: ['mark_refunded', 'resume_order'],
    },
    buyer: {
      pending: ['cancel_order'],
      accepted: ['check_chain', 'report_issue'],
      paid: ['check_chain', 'report_issue'],
      shipped: ['confirm_delivery', 'report_issue'],
      completed: [],
      cancelled: [],
      refunded: [],
      disputed: ['check_chain', 'cancel_order'],
    },
  };
  for (const viewer of ['vendor', 'buyer']) {
    assert.deepEqual(Object.keys(expected[viewer]).sort(), [...ORDER_STATUSES].sort());
    for (const status of ORDER_STATUSES) {
      assert.deepEqual(names(allowedActionsFor({ status, ...unpaid }, viewer)), expected[viewer][status], `${viewer} ${status}`);
    }
  }
  // Payment state narrows both sides' options (security S6): a confirmed
  // payment leaves nothing to check on the chain, on either card.
  assert.deepEqual(names(allowedActionsFor({ status: 'accepted', paymentState: 'seen', paymentSeenBy: 'vendor' }, 'vendor')), ['check_chain']);
  assert.deepEqual(names(allowedActionsFor({ status: 'paid', paymentState: 'seen' }, 'vendor')), ['check_chain', 'mark_shipped']);
  assert.deepEqual(names(allowedActionsFor({ status: 'paid', paymentState: 'confirmed' }, 'vendor')), ['mark_shipped']);
  assert.deepEqual(names(allowedActionsFor({ status: 'accepted', paymentState: 'confirmed' }, 'buyer')), ['report_issue']);
  // A disputed order is not a dead end (security S6): resolution exists.
  for (const item of allowedActionsFor({ status: 'disputed' }, 'vendor')) assert.ok(['mark_refunded', 'resume_order'].includes(item.action), item.action);
  for (const item of allowedActionsFor({ status: 'disputed' }, 'buyer')) assert.ok(['check_chain', 'cancel_order'].includes(item.action), item.action);
  // Every action has a label.
  for (const status of ORDER_STATUSES) for (const viewer of ['vendor', 'buyer']) {
    for (const item of allowedActionsFor({ status, ...unpaid }, viewer)) assert.ok(item.label, item.action);
  }
});

test('a status the machine does not know is an error, and the card shows no buttons', () => {
  assert.throws(() => allowedActionsFor({ status: 'delivered' }, 'vendor'), /Unknown order status: delivered/);
  assert.throws(() => allowedActionsFor({ status: 'pending' }, 'arbiter'), /Unknown order viewer/);
  const odd = request(false, { status: 'voided' });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(orderActionsFor(odd, [odd]), []);
  } finally {
    console.warn = warn;
  }
});

test('a buyer cancel removes Accept from the vendor card, and buyer actions sit on the buyer card', () => {
  const theirs = request(false);
  assert.deepEqual(names(orderActionsFor(theirs, [theirs])), ['accept_order', 'decline_order']);
  const cancelled = update('u1', false, 'cancelled', 11);
  assert.deepEqual(orderActionsFor(theirs, [theirs, cancelled]), []);
  assert.equal(orderState([theirs, cancelled], 'order-1', theirs).status, 'cancelled');

  const mine = request(true);
  const shipped = update('u2', false, 'shipped', 12);
  assert.deepEqual(orderActionsFor(mine, [mine, shipped]).map(({ action, target }) => `${action}:${target}`), ['confirm_delivery:peer', 'report_issue:peer']);
  assert.deepEqual(orderActionsFor(shipped, [mine, shipped]), []);
  assert.deepEqual(orderActionsFor(theirs, [theirs, update('u3', true, 'accepted', 11)]).map(({ target }) => target), ['request', 'request']);
});

test('every status an order message is written with is one the machine knows', () => {
  const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const sources = ['../features/chat/useCommerce.js', '../Shop.jsx', '../components/OneTapCheckout.jsx', './proofOfTrade.js'].map(read);
  for (const source of sources) {
    for (const [, literal] of source.matchAll(/status: '([a-z_]+)'/g)) assert.ok(ORDER_STATUSES.includes(literal), literal);
    for (const [, key] of source.matchAll(/ORDER_STATUS\.([A-Z_]+)/g)) assert.ok(key in ORDER_STATUS, key);
  }
  assert.match(read('./proofOfTrade.js'), /RECEIPT_OUTCOMES\.includes\(input\.outcome\)/);
  assert.deepEqual(RECEIPT_OUTCOMES, ['confirmed', 'rugged', 'refunded']);
});

test('the action table and the handlers name the same actions, with nothing left over', () => {
  const commerce = fs.readFileSync(new URL('../features/chat/useCommerce.js', import.meta.url), 'utf8');
  const handled = JSON.parse(commerce.match(/if \(!(\[[^\]]+\])\.includes\(action\)\)/)[1].replace(/'/g, '"'));
  assert.deepEqual([...handled].sort(), [...ORDER_ACTIONS].sort());
  const bubble = fs.readFileSync(new URL('../components/MessageBubble.jsx', import.meta.url), 'utf8');
  for (const action of ORDER_ACTIONS) assert.equal(bubble.includes(`onAction?.('${action}'`), false, `${action} is wired outside the table`);
  assert.equal(bubble.includes("['accept_order', BadgeCheck"), false);
  assert.match(bubble, /orderActionsFor\(\{ \.\.\.message, data: content \}, chatMessages\)/);
});

test('every message action has a way in from the UI, and every menu item has a handler', () => {
  const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const bubble = read('../components/MessageBubble.jsx');
  const commands = read('../features/chat/useMessageCommands.js');
  const handled = new Set([...commands.matchAll(/action === '([a-z_]+)'/g)].map((m) => m[1]));
  const menu = new Set([...bubble.matchAll(/\['([a-z_]+)', [A-Z][A-Za-z0-9]+, '[^']+'\]/g)].map((m) => m[1]));
  const direct = new Set([...bubble.matchAll(/(?:onAction\?\.|\bact)\('([a-z_]+)'/g)].map((m) => m[1]));
  const offered = new Set([...menu, ...direct]);
  for (const action of handled) assert.ok(offered.has(action), `${action} is handled but nothing offers it`);
  for (const action of menu) assert.ok(handled.has(action), `${action} is offered but not handled`);
  assert.ok(menu.has('view_vendor') && menu.has('edit_product'));
  const overlays = read('../features/chat/ChatOverlays.jsx');
  assert.match(overlays, /<VendorStorefront\s+isOpen=\{!!vendorStorefrontPubkey\}/);
  assert.match(overlays, /<ProductEditModal editingProduct=\{editingProduct\}[^\n]*onSubmit=\{handleSaveEditedProduct\}/);
});

test('issued addresses freeze on the card, and an empty pair is nothing issued', () => {
  // Once an address is issued for an order it is frozen there (security S5):
  // acceptance reuses these and never derives a fresh pair.
  assert.deepEqual(issuedPaymentMethods({ paymentMethods: { btc: ' bc1qorder ', xmr: '' } }), { btc: 'bc1qorder', xmr: null });
  assert.deepEqual(issuedPaymentMethods({ paymentMethods: { btc: '', xmr: '8sub' } }), { btc: null, xmr: '8sub' });
  assert.equal(issuedPaymentMethods({}), null);
  assert.equal(issuedPaymentMethods({ paymentMethods: {} }), null);
  assert.equal(issuedPaymentMethods({ paymentMethods: { btc: '', xmr: '' } }), null);
  assert.equal(issuedPaymentMethods({ paymentMethods: null }), null);
  assert.equal(issuedPaymentMethods(null), null);
});

test('a receipt binds only an order this device tracks as accepted or later', () => {
  const acceptance = update('u1', false, ORDER_STATUS.ACCEPTED, 20, {
    paymentState: 'address_issued',
    coinAmount: '0.01',
    coinCurrency: 'btc',
    paymentMethods: { btc: 'bc1qorder', xmr: '' },
  });
  const paid = update('u2', false, ORDER_STATUS.PAID, 30, { paymentState: 'seen' });
  // Missing order: no request card, nothing binds.
  assert.equal(orderRecordForReceipt([acceptance, paid], 'order-1'), null);
  assert.equal(orderRecordForReceipt([], 'order-1'), null);
  const pending = request(true, {});
  // A pending order — no acceptance on record — never agreed to anything.
  assert.equal(orderRecordForReceipt([pending], 'order-1'), null);
  // Closed stays closed while it is the newest state on the order.
  const cancelled = update('uc', true, ORDER_STATUS.CANCELLED, 50);
  const disputed = update('ud', true, ORDER_STATUS.DISPUTED, 50);
  assert.equal(orderRecordForReceipt([pending, acceptance, paid, cancelled], 'order-1'), null);
  assert.equal(orderRecordForReceipt([pending, acceptance, paid, disputed], 'order-1'), null);
  // The record adopts the order's amount and the address this device issued.
  const record = orderRecordForReceipt([pending, acceptance, paid], 'order-1');
  assert.equal(record.status, ORDER_STATUS.PAID);
  assert.equal(record.coinCurrency, 'btc');
  assert.equal(record.coinAmount, acceptance.data.coinAmount);
  assert.equal(record.issuedAddress, 'bc1qorder');
  assert.equal(record.isBuyer, true);
  // An amount this device set later wins over the one at acceptance.
  assert.equal(orderRecordForReceipt([pending, acceptance,
    update('u3', true, ORDER_STATUS.PAID, 40, { coinAmount: '0.5' }),
  ], 'order-1').coinAmount, '0.5');
  // The vendor's view of the same order: the counterparty initiated it.
  assert.equal(orderRecordForReceipt([request(false, {}), acceptance, paid], 'order-1').isBuyer, false);
  // A chat with only non-order messages binds nothing.
  assert.equal(orderRecordForReceipt([{ id: 'u5', isSender: false, timestamp: 20, data: { type: 'text', message: 'hi' } }], 'order-1'), null);
});

// F4 re-attack: the record reads what this device wrote. A received update is
// the peer's word, so its payment fields never shrink the amount or move the
// issued address on the side that owns them.
test('a fake later update cannot shrink the amount or steal the issued address', () => {
  // Mirror role, the vendor as victim: the vendor accepted with its own
  // methods, then a forged later update from the peer rewrites both.
  const vendorCard = request(false, {});
  const acceptance = update('u1', true, ORDER_STATUS.ACCEPTED, 20, {
    coinAmount: '0.01', coinCurrency: 'btc', paymentMethods: { btc: 'bc1qv' },
  });
  const hijack = update('u2', false, ORDER_STATUS.ACCEPTED, 30, {
    coinAmount: '0.000001', coinCurrency: 'btc', paymentMethods: { btc: 'bc1qattacker' },
  });
  const record = orderRecordForReceipt([vendorCard, acceptance, hijack], 'order-1');
  assert.equal(record.coinAmount, '0.01');
  assert.equal(record.issuedAddress, 'bc1qv');
  // The buyer's own product price wins over a peer update claiming less.
  const priced = request(true, { product: { title: 'Tee', price: '0.02', currency: 'btc' } });
  const shrunk = orderRecordForReceipt([priced, update('u3', false, ORDER_STATUS.ACCEPTED, 21, { coinAmount: '0.01', coinCurrency: 'btc' })], 'order-1');
  assert.equal(shrunk.coinAmount, '0.02');
  // An order without its issued address gets none, and binds no address check.
  const noAddress = orderRecordForReceipt([request(true, {}), update('u4', false, ORDER_STATUS.ACCEPTED, 20, { coinAmount: '0.01', coinCurrency: 'btc' })], 'order-1');
  assert.equal(noAddress.coinAmount, '0.01');
  assert.equal(noAddress.issuedAddress, '');
});

// F7: the payment facts on an order are earned on this device, never asserted
// by the peer.
test('a peer cannot forge the payment facts an order acts on', () => {
  // A forged request card pre-claims 'confirmed' and watcher sight, and a
  // forged update repeats it. The claim shows as the status, but no payment
  // fact adopts it without local evidence or a verified receipt.
  const claimedCard = request(false, { status: ORDER_STATUS.ACCEPTED, paymentState: 'confirmed', paymentSeenBy: 'watcher' });
  const claimed = update('u1', false, ORDER_STATUS.PAID, 11, { paymentState: 'confirmed', paymentSeenBy: 'watcher' });
  const state = orderState([claimedCard, claimed], 'order-1', claimedCard);
  assert.equal(state.status, ORDER_STATUS.PAID);
  assert.equal(state.paymentState, 'created');
  assert.equal(state.paymentSeenBy, '');
  // The chain check survives the claim, and the claim alone never opens
  // shipping.
  assert.deepEqual(names(allowedActionsFor(state, 'vendor')), ['check_chain']);
});

test('the device\'s own actions are the evidence the card acts on', () => {
  const theirs = request(false);
  const acceptCard = { ...theirs, localPatch: { status: ORDER_STATUS.ACCEPTED, paymentState: 'address_issued' } };
  assert.equal(orderState([acceptCard], 'order-1', acceptCard).paymentState, 'address_issued');
  // The vendor's own update carries their own wallet sight.
  const seen = update('u2', true, ORDER_STATUS.PAID, 12, { paymentState: 'seen', paymentSeenBy: 'vendor' });
  const state = orderState([acceptCard, seen], 'order-1', acceptCard);
  assert.equal(state.paymentState, 'seen');
  assert.equal(state.paymentSeenBy, 'vendor');
  assert.deepEqual(names(allowedActionsFor({ ...state, status: seen.data.status }, 'vendor')), ['check_chain', 'mark_shipped']);
  // A local patch sets the same evidence a seen update does.
  const confirmedCard = { ...theirs, localPatch: { status: ORDER_STATUS.PAID, paymentState: 'confirmed' } };
  assert.equal(orderState([confirmedCard], 'order-1', confirmedCard).paymentState, 'confirmed');
  // The vendor's own card with an issued address, then a claim riding in
  // from the peer: the record still refuses the peer's payment facts.
  assert.equal(orderState([confirmedCard, update('u3', false, ORDER_STATUS.PAID, 13, { paymentState: 'confirmed' })], 'order-1', confirmedCard).paymentState, 'confirmed');
});

test('a receipt both parties signed is the one artifact moving the payment', () => {
  const buyerKey = schnorr.utils.randomSecretKey();
  const vendorKey = schnorr.utils.randomSecretKey();
  const body = {
    orderId: 'order-1',
    buyer: hexOf(schnorr.getPublicKey(buyerKey)),
    vendor: hexOf(schnorr.getPublicKey(vendorKey)),
    currency: 'xmr',
    address: '8secret',
    amount: '1',
    txid: 'aa',
    at: 1_700_000_000,
    outcome: 'confirmed',
  };
  const signed = signReceipt(vendorKey, body, signReceipt(buyerKey, body));
  const theirs = request(false, { status: ORDER_STATUS.PAID });
  const riding = update('u4', false, ORDER_STATUS.PAID, 14, { paymentState: 'confirmed', paymentSeenBy: 'watcher', receipt: signed });
  const state = orderState([theirs, riding], 'order-1', theirs);
  assert.equal(state.paymentState, 'confirmed');
  assert.deepEqual(names(allowedActionsFor(state, 'vendor')), ['mark_shipped']);
  // A receipt naming another order buys nothing here.
  const signedOther = signReceipt(vendorKey, { ...body, orderId: 'order-2' }, signReceipt(buyerKey, { ...body, orderId: 'order-2' }));
  assert.equal(
    orderState([theirs, update('u5', false, ORDER_STATUS.PAID, 15, { receipt: signedOther })], 'order-1', theirs).paymentState,
    'created',
  );
  // A tampered receipt fails verification, and verification failing means
  // nothing moves.
  const tampered = { ...signed, body: { ...signed.body, amount: '2' } };
  assert.equal(
    orderState([theirs, update('u6', false, ORDER_STATUS.PAID, 16, { receipt: tampered })], 'order-1', theirs).paymentState,
    'created',
  );
  // A receipt with no stated outcome still proves the chain saw the payment.
  const sight = signReceipt(vendorKey, { ...body, outcome: '' }, signReceipt(buyerKey, { ...body, outcome: '' }));
  assert.equal(
    orderState([theirs, update('u7', false, ORDER_STATUS.PAID, 17, { receipt: sight })], 'order-1', theirs).paymentState,
    'seen',
  );
});

test('a disputed order keeps a resolution and a chain entry for both sides (security S6)', () => {
  const pending = request(true, {});
  const dispute = update('ud', false, 'disputed', 20, { disputeReason: 'never shipped' });
  // Buyer card while the order is disputed: check the chain themselves, or
  // abandon the order. Not nothing.
  const seen = update('u1', false, 'accepted', 12, { paymentState: 'address_issued' });
  assert.deepEqual(names(orderActionsFor(pending, [pending, seen, dispute])), ['check_chain', 'cancel_order']);
  // A watched payment that is already confirmed leaves only the abandon
  // step. The confirmation is the buyer's own watcher fact — a local patch on
  // their card — not a received claim, which never counts as evidence (F7).
  const confirmed = update('u2', false, 'paid', 14, { paymentState: 'confirmed' });
  assert.deepEqual(names(orderActionsFor(pending, [pending, confirmed, dispute])), ['check_chain', 'cancel_order']);
  const confirmedCard = { ...pending, localPatch: { paymentState: 'confirmed' } };
  assert.deepEqual(names(orderActionsFor(confirmedCard, [confirmedCard, dispute])), ['cancel_order']);
  // Vendor card while disputed.
  const theirs = request(false, {});
  assert.deepEqual(orderActionsFor(theirs, [theirs, dispute]).map(({ action, target }) => `${action}:${target}`), ['mark_refunded:request', 'resume_order:request']);
});

test('a dispute reopen goes back to what the payment reached, and both sides compute the same', () => {
  assert.equal(reopenedStatus('address_issued'), 'accepted');
  assert.equal(reopenedStatus('created'), 'accepted');
  assert.equal(reopenedStatus(undefined), 'accepted');
  assert.equal(reopenedStatus('seen'), 'paid');
  assert.equal(reopenedStatus('confirmed'), 'paid');
  // A reopen names the status it restores, so the buyer's card takes the same
  // step without recomputing history. Falls back when the payment never moved.
  assert.equal(reopenedStatus(), 'accepted');
  assert.equal(reopenedStatus('rugged'), 'accepted');
});

test('the payment details either side check come from the order updates (security S6)', () => {
  const buyerCard = request(true, { status: 'pending' });
  const acceptance = update('u1', false, 'accepted', 12, {
    paymentState: 'address_issued',
    paymentMethods: { btc: 'bc1qorder', xmr: '' },
    coinAmount: '0.01',
    coinCurrency: 'btc',
  });
  const paid = update('u2', false, 'paid', 20, { paymentState: 'seen', paymentSeenBy: 'watcher' });
  const details = orderPaymentDetails([buyerCard, acceptance, paid], 'order-1');
  // The buyer's own card carried no address; the acceptance supplies it.
  assert.deepEqual(details.paymentMethods, { btc: 'bc1qorder', xmr: '' });
  assert.equal(details.coinCurrency, 'btc');
  assert.equal(details.coinAmount, '0.01');
  // A received "seen" claim is not payment evidence (F7): the details carry
  // what this device has earned, never what an update asserts.
  assert.equal(details.paymentState, 'created');
  assert.equal(details.paymentSeenBy, '');
  assert.equal(details.status, 'paid');
  // The vendor's own view reads the same updates for their card.
  const vendorRecord = orderRecordForReceipt([request(false, {}), acceptance, paid], 'order-1');
  assert.equal(vendorRecord.issuedAddress, 'bc1qorder');
  // The vendor's card carries the same acceptance as its own patch fallback.
  const vendorCard = request(false, { paymentMethods: { btc: 'bc1qcard', xmr: '' }, coinAmount: '0.02', coinCurrency: 'btc' });
  assert.deepEqual(orderPaymentDetails([vendorCard, acceptance], 'order-1').paymentMethods, { btc: 'bc1qorder', xmr: '' });
  // Nothing to read: no request card, no details.
  assert.equal(orderPaymentDetails([acceptance], 'order-2'), null);
  assert.equal(orderPaymentDetails([], 'order-1'), null);
});

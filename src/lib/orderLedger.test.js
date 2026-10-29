import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { defaultLedgerSide, discardRejectedOrder, orderRows, peerRole } from './orderLedger.js';
import { orderHasVerifiedReceipt, orderState } from './orderActions.js';
import { signReceipt } from './proofOfTrade.js';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

function store(seed) {
  let dms = seed;
  return {
    get dms() { return dms; },
    setDms: (next) => { dms = typeof next === 'function' ? next(dms) : next; },
  };
}

const failedOrder = () => ({ clientId: 'temp-1', id: 'temp-1', isSender: true, data: { type: 'cipher_order' } });

test('a rejected order leaves both places it was written — the visible list and the saved row', async () => {
  const visible = store({ vendor: [failedOrder()] });
  const removed = [];
  const result = await discardRejectedOrder({
    vendorPubkey: 'vendor',
    tempId: 'temp-1',
    setDms: visible.setDms,
    removeStored: async (id) => { removed.push(id); },
  });
  assert.deepEqual(result, { cleared: true });
  assert.deepEqual(visible.dms.vendor, [], 'the visible copy is gone');
  assert.deepEqual(removed, ['temp-1'], 'the saved row is deleted by its temp id, so a reload cannot read it back');
});

test('a saved row that will not go is reported, never hidden', async () => {
  const visible = store({ vendor: [failedOrder()] });
  const result = await discardRejectedOrder({
    vendorPubkey: 'vendor',
    tempId: 'temp-1',
    setDms: visible.setDms,
    removeStored: async () => { throw new Error('database locked'); },
  });
  assert.equal(result.cleared, false);
  assert.match(String(result.error?.message), /database locked/);
  assert.deepEqual(visible.dms.vendor, [], 'the visible copy still goes');
});

test('another peer\'s messages survive the cleanup untouched', async () => {
  const other = { clientId: 'temp-9', id: 'temp-9', isSender: true, data: { type: 'cipher_order' } };
  const visible = store({ vendor: [failedOrder()], other: [other] });
  await discardRejectedOrder({
    vendorPubkey: 'vendor',
    tempId: 'temp-1',
    setDms: visible.setDms,
    removeStored: async () => {},
  });
  assert.deepEqual(visible.dms.other, [other]);
});

// ————— the two ledgers one account can hold —————

const sent = (id, timestamp) => ({ id, clientId: id, isSender: true, timestamp, data: { type: 'cipher_order', product: { title: id } } });
const received = (id, timestamp) => ({ id, clientId: id, isSender: false, timestamp, data: { type: 'order_request', product: { title: id } } });
const chatter = (id, timestamp) => ({ id, clientId: id, isSender: true, timestamp, data: { type: 'text', message: id } });

const ledger = () => ({
  vendor: [sent('bought-1', 100), received('incoming-1', 200), chatter('hello', 300)],
  other: [sent('bought-2', 50)],
});

test('a vendor reads what came in without losing what they placed', () => {
  const incoming = orderRows(ledger(), { side: 'incoming' });
  assert.deepEqual(incoming.map((row) => row.message.id), ['incoming-1']);
  assert.equal(incoming[0].isBuyer, false);
  assert.equal(peerRole(incoming[0].isBuyer), 'Buyer');

  const purchases = orderRows(ledger(), { side: 'purchases' });
  assert.deepEqual(purchases.map((row) => row.message.id), ['bought-1', 'bought-2'], 'newest first, across peers');
  assert.equal(purchases[0].isBuyer, true);
  assert.equal(peerRole(purchases[0].isBuyer), 'Seller');
  assert.equal(purchases.some((row) => row.message.id === 'hello'), false, 'chat is not an order');
});

test('the first ledger a screen opens depends on nothing but the mode it started in', () => {
  assert.equal(defaultLedgerSide(true), 'incoming');
  assert.equal(defaultLedgerSide(false), 'purchases');
  assert.deepEqual(orderRows(ledger(), {}), []);
  assert.deepEqual(orderRows(ledger(), { side: 'everything' }), []);
});

// ————— an order known only by its updates is still an order —————
// The thread draws a card for cipher_order, order_request AND order_update
// (MessageBubble), and this ledger must agree with it. Measured on a real
// profile: 8 order_update rows, 8 cards in the thread, "No orders yet" on
// both ledger sides.

const update = (id, orderId, isSender, timestamp, data = {}) => ({
  id, clientId: id, isSender, timestamp,
  data: { type: 'order_update', status: 'paid', ...(orderId ? { orderId } : {}), ...data },
});

test('an order that exists only as updates makes one ledger row, not none and not one per update', () => {
  const rows = { vendor: [update('u1', 'order-A', true, 100), update('u2', 'order-A', true, 200)] };
  const purchases = orderRows(rows, { side: 'purchases' });
  assert.equal(purchases.length, 1, 'one row for the order');
  assert.equal(purchases[0].orderId, 'order-A');
  assert.equal(purchases[0].message.id, 'u1', 'anchored on the earliest update, which says what the order first was');
  assert.equal(orderRows(rows, { side: 'incoming' }).length, 0, 'the direction still comes from the row it anchors on');
});

test('a request plus three updates is exactly one row, and it reads the request', () => {
  const request = {
    id: 'order-B', clientId: 'order-B', isSender: true, timestamp: 100,
    data: { type: 'cipher_order', product: { title: 'Washer', priceUsd: '24.00' } },
  };
  const rows = { vendor: [request,
    update('u1', 'order-B', false, 110),
    update('u2', 'order-B', false, 120),
    update('u3', 'order-B', false, 130)] };
  const purchases = orderRows(rows, { side: 'purchases' });
  assert.equal(purchases.length, 1, 'one row, anchored on the request');
  assert.equal(purchases[0].message.id, 'order-B');
  assert.equal(purchases[0].orderId, 'order-B', 'the row names the order, which is what the screen reads its state and receipt by');
  assert.deepEqual(purchases[0].message.data.product, { title: 'Washer', priceUsd: '24.00' }, 'product and price come from the request');
  assert.equal(purchases[0].isBuyer, true);
  assert.equal(orderRows(rows, { side: 'incoming' }).length, 0, 'the peer replying never moves the order to the other ledger');
});

test('when both request kinds carry one order id, the winner is fixed by the rule, not by array order', () => {
  const cipher = { id: 'order-X', clientId: 'order-X', isSender: true, timestamp: 100, data: { type: 'cipher_order' } };
  const request = { id: 'order-X', clientId: 'order-X', isSender: true, timestamp: 100, data: { type: 'order_request' } };
  const one = orderRows({ vendor: [cipher, request] }, { side: 'purchases' });
  const two = orderRows({ vendor: [request, cipher] }, { side: 'purchases' });
  assert.equal(one.length, 1, 'the same order id is one row whatever carries it');
  assert.equal(one[0].message.data.type, 'cipher_order', 'a timestamp tie goes to the earlier kind name');
  assert.equal(two[0].message.data.type, 'cipher_order', 'and the answer does not depend on the order they arrive in');
  // A real timestamp difference outranks the kind name.
  const early = orderRows({ vendor: [{ ...request, timestamp: 90 }, cipher] }, { side: 'purchases' });
  assert.equal(early[0].message.data.type, 'order_request', 'the earlier timestamp wins first');
});

// The row's id is load-bearing, not decorative: orderState and
// orderHasVerifiedReceipt (orderActions) both look updates up by
// `data.orderId === orderId`. Hand them the anchored UPDATE's message id and
// they find nothing — the row draws with no ✓, which is the whole point of
// the card. This is the acceptance case BOSS named.
const hexOf2 = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

test('an update-only order that carries a verified receipt draws its row AND its tick', () => {
  const buyerKey = schnorr.utils.randomSecretKey();
  const vendorKey = schnorr.utils.randomSecretKey();
  const buyer = hexOf2(schnorr.getPublicKey(buyerKey));
  const vendor = hexOf2(schnorr.getPublicKey(vendorKey));
  const body = {
    orderId: 'order-R', buyer, vendor, currency: 'xmr', address: '8secret',
    amount: '1', txid: 'aa', at: 1_700_000_000, outcome: 'confirmed',
  };
  const signed = signReceipt(vendorKey, body, signReceipt(buyerKey, body));
  const thread = [
    { id: 'u1', isSender: false, pubkey: vendor, timestamp: 11, data: { type: 'order_update', orderId: 'order-R', status: 'paid' } },
    { id: 'u2', isSender: false, pubkey: vendor, timestamp: 12, data: { type: 'order_update', orderId: 'order-R', status: 'paid', receipt: signed } },
  ];
  // The buyer's own device: these updates came FROM the vendor, so the
  // anchored message's isSender is false — and the row still belongs to the
  // buyer's purchases, because the receipt names the buyer.
  const rows = orderRows({ [vendor]: thread }, { side: 'purchases', ownPubkey: buyer });
  assert.equal(rows.length, 1, 'the row exists although no request row does');
  assert.equal(orderRows({ [vendor]: thread }, { side: 'incoming', ownPubkey: buyer }).length, 0, 'a received update is not automatically an incoming order');
  const row = rows[0];
  // The tick is asserted first so a naive id fails HERE, at the symptom a
  // person would see — a paid order with no ✓ — not at a field comparison.
  assert.equal(orderHasVerifiedReceipt(thread, row.orderId, row.message, buyer, vendor), true, 'the countersigned tick is found');
  assert.equal(row.orderId, 'order-R', 'the row names the order the updates name — never the update message id');
  assert.equal(row.message.id, 'u1', 'and the message it anchors on is still the earliest update');
  assert.equal(orderHasVerifiedReceipt(thread, row.message.id, row.message, buyer, vendor), false, 'proof the id rule is load-bearing: the message id finds no receipt');
  assert.equal(orderState(thread, row.orderId, row.message, buyer, vendor).status, 'paid');
});

test('an acceptance-only order reads as the buyer\'s purchase and the vendor\'s incoming order', () => {
  const buyer = 'b'.repeat(64);
  const vendor = 'c'.repeat(64);
  // The vendor's acceptance reply: no request row was kept, so this update is
  // all the order has. It carries the pair the vendor issued.
  const acceptance = (isSender) => ({
    id: 'acc-1', isSender, timestamp: 100,
    data: {
      type: 'order_update', orderId: 'order-v', status: 'accepted', paymentState: 'address_issued',
      coinCurrency: 'btc', coinAmount: '0.001', paymentMethods: { btc: 'bc1qissued', xmr: null },
    },
  });
  // At the buyer: the acceptance arrived.
  const atBuyer = orderRows({ [vendor]: [acceptance(false)] }, { side: 'purchases', ownPubkey: buyer });
  assert.equal(atBuyer.length, 1, 'the buyer sees the order they placed');
  assert.equal(atBuyer[0].isBuyer, true);
  assert.equal(orderRows({ [vendor]: [acceptance(false)] }, { side: 'incoming', ownPubkey: buyer }).length, 0);
  // At the vendor: the same row was sent by this device.
  const atVendor = orderRows({ [buyer]: [acceptance(true)] }, { side: 'incoming', ownPubkey: vendor });
  assert.equal(atVendor.length, 1, 'the vendor sees the order they were sent');
  assert.equal(atVendor[0].isBuyer, false);
  assert.equal(orderRows({ [buyer]: [acceptance(true)] }, { side: 'purchases', ownPubkey: vendor }).length, 0);
});

test('with neither a receipt nor an issued pair, a row still lists and keeps its own flag', () => {
  const buyer = 'b'.repeat(64);
  const rows = orderRows({ peer: [update('u1', 'order-n', false, 100)] }, { side: 'incoming', ownPubkey: buyer });
  assert.equal(rows.length, 1, 'a row is never dropped for being unsure');
  assert.equal(rows[0].isBuyer, false);
});

test('two peers using the same order id stay two rows, never one merged order', () => {
  const rows = {
    alice: [update('a1', 'order-1', true, 200)],
    bob: [update('b1', 'order-1', true, 100)],
  };
  const purchases = orderRows(rows, { side: 'purchases' });
  assert.deepEqual(purchases.map((row) => row.peerPubkey), ['alice', 'bob'], 'one chat\'s order is never merged with another\'s');
});

test('an update with no order id is listed under its own id, never silently dropped', () => {
  const rows = { vendor: [update('u9', null, true, 100)] };
  const purchases = orderRows(rows, { side: 'purchases' });
  assert.equal(purchases.length, 1, 'the thread files it the same way (orderId, else the message id), so the tab lists it');
  assert.equal(purchases[0].orderId, 'u9');
});

test('an order row with no id at all is still listed', () => {
  const rows = { vendor: [{ isSender: true, timestamp: 100, data: { type: 'cipher_order' } }] };
  const purchases = orderRows(rows, { side: 'purchases' });
  assert.equal(purchases.length, 1, 'a saved row with no id is drawn by the thread, so it is listed here too');
  assert.equal(typeof purchases[0].orderId, 'string');
});

// ————— the screen is wired to these, not to the mode flag —————

test('the orders screen filters by its own view and reads each row\'s direction', () => {
  const screen = read('../components/chat/MyOrders.jsx');
  assert.match(screen, /import \{ defaultLedgerSide, orderRows, peerRole \} from '\.\.\/\.\.\/lib\/orderLedger'/);
  assert.match(screen, /useState\(\(\) => defaultLedgerSide\(isVendor\)\)/);
  assert.match(screen, /orderRows\(rows, \{ side, ownPubkey \}\)/, 'the screen hands the ledger its own key, which the direction rule reads');
  assert.match(screen, /peerRole\(isBuyer\)/);
  // The row is keyed and read by the ORDER it stands for, not by the message
  // that anchors it: an update-only order anchors on an update whose id is not
  // the order id, and the status and receipt lookups must still land.
  assert.match(screen, /orderState\(rows\[peerPubkey\], orderId, message/, 'state is read for the order the row names');
  assert.match(screen, /orderHasVerifiedReceipt\(rows\[peerPubkey\], orderId, message/);
  assert.match(screen, /key=\{orderId\}/, 'one row per order, keyed by the order');
  assert.match(screen, /\{isBuyer && \(/, 'the menu door follows the row\'s direction');
  assert.equal(/!isVendor && /.test(screen), false, 'the mode no longer decides which rows show a menu');
  assert.equal(/isVendor \? !message\.isSender : message\.isSender/.test(screen), false, 'the old mode filter is gone');
  assert.equal(/onClick=\{\(\) => \{ haptic\('light'\); setSide\(view\.id\); \}\}/.test(screen), true);
  assert.equal(/setIsVendor\(/.test(screen), false, 'choosing a ledger never touches vendor mode');
});

test('the checkout failure branch cleans up, and a queued order never takes that path', () => {
  const menus = read('../Menus.jsx');
  assert.match(menus, /import \{ saveMessage, db \} from '\.\/db'/);
  assert.match(menus, /discardRejectedOrder\(\{/);
  assert.match(menus, /removeStored: \(id\) => db\.messages\.delete\(id\)/);
  // The cleanup sits inside the explicit failure branch, after the send.
  const failure = menus.slice(menus.indexOf('if (!result?.success)'), menus.indexOf('const confirmed = {'));
  assert.match(failure, /discardRejectedOrder/);
  assert.match(failure, /a reload may show it again/);
  assert.equal(/db\.messages\.delete/.test(failure), true);
  // Nothing after the failure branch deletes a row, so a queued order stays.
  const after = menus.slice(menus.indexOf('const confirmed = {'));
  assert.equal(/discardRejectedOrder/.test(after), false);
  assert.equal(/db\.messages\.delete/.test(after), false);
  assert.match(menus, /deliveryStatus: result\.queued \? 'queued' : 'sent'/);
});

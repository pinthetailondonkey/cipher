import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ORDER_ACTIONS, allowedActionsFor, orderActionsFor, orderRecordForReceipt, orderState } from './orderActions.js';
import { ORDER_STATUS, ORDER_STATUSES, RECEIPT_OUTCOMES } from './paymentState.js';

const names = (actions) => actions.map((item) => item.action);
const request = (isSender, data = {}) => ({ id: 'order-1', isSender, timestamp: 10, data: { type: 'order_request', status: 'pending', product: { title: 'Tee' }, ...data } });
const update = (id, isSender, status, timestamp, extra = {}) => ({ id, isSender, timestamp, data: { type: 'order_update', orderId: 'order-1', status, ...extra } });

test('every status for both viewers gets exactly the actions in the table', () => {
  const unpaid = { paymentState: 'address_issued', paymentSeenBy: '' };
  const expected = {
    vendor: {
      pending: ['accept_order', 'decline_order'],
      accepted: ['confirm_payment', 'check_chain'],
      paid: ['check_chain', 'mark_shipped'],
      shipped: [],
      completed: [],
      cancelled: [],
      disputed: [],
    },
    buyer: {
      pending: ['cancel_order'],
      accepted: ['report_issue'],
      paid: ['report_issue'],
      shipped: ['confirm_delivery', 'report_issue'],
      completed: [],
      cancelled: [],
      disputed: [],
    },
  };
  for (const viewer of ['vendor', 'buyer']) {
    assert.deepEqual(Object.keys(expected[viewer]).sort(), [...ORDER_STATUSES].sort());
    for (const status of ORDER_STATUSES) {
      assert.deepEqual(names(allowedActionsFor({ status, ...unpaid }, viewer)), expected[viewer][status], `${viewer} ${status}`);
    }
  }
  // Payment state narrows the vendor's options.
  assert.deepEqual(names(allowedActionsFor({ status: 'accepted', paymentState: 'seen', paymentSeenBy: 'vendor' }, 'vendor')), ['check_chain']);
  assert.deepEqual(names(allowedActionsFor({ status: 'paid', paymentState: 'confirmed' }, 'vendor')), ['mark_shipped']);
  // Every action has a label.
  for (const status of ORDER_STATUSES) for (const viewer of ['vendor', 'buyer']) {
    for (const item of allowedActionsFor({ status, ...unpaid }, viewer)) assert.ok(item.label, item.action);
  }
});

test('a status the machine does not know is an error, and the card shows no buttons', () => {
  assert.throws(() => allowedActionsFor({ status: 'delivered' }, 'vendor'), /Unknown order status: delivered/);
  assert.throws(() => allowedActionsFor({ status: 'pending' }, 'arbiter'), /Unknown order viewer/);
  const odd = request(false, { status: 'refunded' });
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
  // An amount either side set later wins over the one at acceptance.
  assert.equal(orderRecordForReceipt([pending, acceptance,
    update('u3', true, ORDER_STATUS.PAID, 40, { coinAmount: '0.5' }),
  ], 'order-1').coinAmount, '0.5');
  // An order without its issued address gets none, and binds no address check.
  const noAddress = orderRecordForReceipt([pending, update('u4', false, ORDER_STATUS.ACCEPTED, 20, { coinAmount: '0.01', coinCurrency: 'btc' })], 'order-1');
  assert.equal(noAddress.coinAmount, '0.01');
  assert.equal(noAddress.issuedAddress, '');
  // The vendor's view of the same order: the counterparty initiated it.
  assert.equal(orderRecordForReceipt([request(false, {}), acceptance, paid], 'order-1').isBuyer, false);
  // A chat with only non-order messages binds nothing.
  assert.equal(orderRecordForReceipt([{ id: 'u5', isSender: false, timestamp: 20, data: { type: 'text', message: 'hi' } }], 'order-1'), null);
});

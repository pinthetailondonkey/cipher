import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ORDER_ACTIONS, allowedActionsFor, orderActionsFor, orderState } from './orderActions.js';
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

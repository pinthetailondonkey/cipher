import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { orderActionsFor, orderState } from './orderActions.js';

const names = (actions) => actions.map((item) => item.action);
const request = (isSender, data = {}) => ({ id: 'order-1', isSender, timestamp: 10, data: { type: 'order_request', status: 'pending', product: { title: 'Tee' }, ...data } });
const update = (id, isSender, status, timestamp, extra = {}) => ({ id, isSender, timestamp, data: { type: 'order_update', orderId: 'order-1', status, ...extra } });

test('the vendor can decline a new order and ship a paid one', () => {
  const order = request(false);
  assert.deepEqual(names(orderActionsFor(order, [order])), ['decline_order']);
  const accepted = request(false, { status: 'accepted' });
  const acceptedUpdate = update('u1', true, 'accepted', 11);
  assert.deepEqual(names(orderActionsFor(accepted, [accepted, acceptedUpdate])), []);
  const paidUpdate = update('u2', true, 'paid', 12, { paymentState: 'confirmed' });
  assert.deepEqual(names(orderActionsFor(accepted, [accepted, acceptedUpdate, paidUpdate])), ['mark_shipped']);
  const shipped = update('u3', true, 'shipped', 13);
  assert.deepEqual(names(orderActionsFor(accepted, [accepted, acceptedUpdate, paidUpdate, shipped])), []);
  const cancelledByBuyer = update('u4', false, 'cancelled', 14);
  assert.deepEqual(names(orderActionsFor(order, [order, cancelledByBuyer])), []);
});

test('the buyer can cancel before acceptance, then confirm delivery or report on the newest update', () => {
  const mine = request(true);
  assert.deepEqual(orderActionsFor(mine, [mine]), [{ action: 'cancel_order', label: 'Cancel order', target: 'peer' }]);
  const accepted = update('u1', false, 'accepted', 11);
  assert.deepEqual(names(orderActionsFor(mine, [mine, accepted])), []);
  assert.deepEqual(names(orderActionsFor(accepted, [mine, accepted])), ['report_issue']);
  const shipped = update('u2', false, 'shipped', 12);
  const chat = [mine, accepted, shipped];
  assert.deepEqual(names(orderActionsFor(accepted, chat)), []);
  assert.deepEqual(orderActionsFor(shipped, chat).map((item) => item.target), ['order', 'order']);
  assert.deepEqual(names(orderActionsFor(shipped, chat)), ['confirm_delivery', 'report_issue']);
  const done = update('u3', true, 'completed', 13);
  assert.deepEqual(names(orderActionsFor(shipped, [...chat, done])), []);
  assert.equal(orderState([...chat, done], 'order-1', mine).status, 'completed');
});

test('a vendor never gets buyer buttons on an update the buyer sent', () => {
  const theirs = request(false, { status: 'accepted' });
  const buyerReport = update('u9', false, 'disputed', 20);
  assert.deepEqual(orderActionsFor(buyerReport, [theirs, buyerReport]), []);
});

test('every order action is reachable from a card', () => {
  const bubble = fs.readFileSync(new URL('../components/MessageBubble.jsx', import.meta.url), 'utf8');
  assert.match(bubble, /orderActionsFor\(/);
  const helper = fs.readFileSync(new URL('./orderActions.js', import.meta.url), 'utf8');
  for (const action of ['decline_order', 'cancel_order', 'mark_shipped', 'confirm_delivery', 'report_issue']) {
    assert.match(helper, new RegExp(`'${action}'`));
  }
  for (const action of ['accept_order', 'confirm_payment', 'check_chain']) assert.match(bubble, new RegExp(`'${action}'`));
});

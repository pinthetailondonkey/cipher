import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  amountParts,
  BOTTOM_NAV_ITEMS,
  capBadge,
  formatAmount,
  orderGroupOf,
  orderStatusLabel,
  placeMenu,
  shortOrderId,
  transactionView,
} from './logic.js';

test('badge counts cap at 99+ and hide at zero or nonsense', () => {
  assert.equal(capBadge(0), '');
  assert.equal(capBadge(-3), '');
  assert.equal(capBadge(undefined), '');
  assert.equal(capBadge('abc'), '');
  assert.equal(capBadge(1), '1');
  assert.equal(capBadge(99), '99');
  assert.equal(capBadge(100), '99+');
  assert.equal(capBadge(24816), '99+');
  assert.equal(capBadge('7'), '7');
  assert.equal(capBadge(2.9), '2');
});

test('amounts are decimal strings, never floats: USD two places, BTC eight, XMR twelve, half up', () => {
  assert.equal(formatAmount('35', 'USD'), '$35');
  assert.equal(formatAmount('35.5', 'USD'), '$35.50');
  assert.equal(formatAmount('1234567.891', 'usd'), '$1,234,567.89');
  assert.equal(formatAmount('35.005', 'USD'), '$35.01');
  assert.equal(formatAmount('10', undefined), '$10');
  assert.equal(formatAmount('0.01', 'BTC'), '0.01 BTC');
  assert.equal(formatAmount('0.010000', 'btc'), '0.01 BTC');
  assert.equal(formatAmount('0.123456785', 'BTC'), '0.12345679 BTC');
  assert.equal(formatAmount('0.123456784', 'BTC'), '0.12345678 BTC');
  assert.equal(formatAmount('0.99999999999', 'BTC'), '1 BTC');
  assert.equal(formatAmount('0.5', 'XMR'), '0.5 XMR');
  // One piconero is the smallest Monero amount and must survive display.
  assert.equal(formatAmount('0.000000000001', 'XMR'), '0.000000000001 XMR');
  assert.equal(formatAmount('0.0000000000005', 'XMR'), '0.000000000001 XMR');
  assert.equal(formatAmount(0.5, 'XMR'), '0.5 XMR');
  assert.equal(formatAmount(12, 'USD'), '$12');
});

test('amounts that cannot be read as a plain decimal show nothing, not a guess', () => {
  for (const bad of ['', null, undefined, 'abc', '-1', '1e-7', '1,5', 'NaN', Infinity, 1e-7, {}, '0x10']) {
    assert.equal(formatAmount(bad, 'BTC'), '', String(bad));
    assert.equal(amountParts(bad, 'BTC'), null, String(bad));
  }
});

test('an unlisted currency keeps its digits and shows its code', () => {
  assert.equal(formatAmount('3.14159', 'ltc'), '3.14159 LTC');
  assert.deepEqual(amountParts('0.01', 'BTC'), { prefix: '', value: '0.01', unit: 'BTC' });
  assert.deepEqual(amountParts('35', 'USD'), { prefix: '$', value: '35', unit: '' });
});

test('an order id shortens to a compact label', () => {
  assert.equal(shortOrderId('a1B2c3d4e5f6'), '#a1b2c3');
  assert.equal(shortOrderId('temp-17000'), '#temp17');
  assert.equal(shortOrderId(''), '');
  assert.equal(shortOrderId(null), '');
});

const S = (status, paymentState = 'created', extra = {}) => ({ status, paymentState, paymentSeenBy: '', resurrected: false, ...extra });

test('status words come from the real order state', () => {
  assert.equal(orderStatusLabel(S('pending')).text, 'Waiting');
  assert.equal(orderStatusLabel(S('accepted', 'address_issued')).text, 'Address sent');
  assert.equal(orderStatusLabel(S('accepted', 'seen')).text, 'Seen on-chain');
  assert.equal(orderStatusLabel(S('accepted', 'confirmed')).text, 'Confirmed');
  assert.equal(orderStatusLabel(S('paid', 'seen', { paymentSeenBy: 'vendor' })).text, 'Marked paid');
  assert.equal(orderStatusLabel(S('shipped', 'confirmed')).text, 'Shipped');
  assert.equal(orderStatusLabel(S('completed', 'confirmed')).text, 'Delivered');
  assert.equal(orderStatusLabel(S('cancelled')).text, 'Cancelled');
  assert.equal(orderStatusLabel(S('refunded')).text, 'Refunded');
  assert.equal(orderStatusLabel(S('disputed', 'seen')).text, 'Disputed');
  assert.equal(orderStatusLabel(S('disputed', 'seen')).tone, 'danger');
});

test('a payment claim the vendor made alone reads as a warning, a chain sighting does not', () => {
  assert.equal(orderStatusLabel(S('paid', 'seen', { paymentSeenBy: 'vendor' })).tone, 'warning');
  assert.equal(orderStatusLabel(S('accepted', 'seen', { paymentSeenBy: 'watcher' })).tone, 'blue');
  assert.equal(orderStatusLabel(S('completed', 'confirmed')).tone, 'success');
});

test('progress shows only once the vendor accepted, and walks the four real payment states', () => {
  assert.equal(transactionView(S('pending'), 'buyer').progress, null);
  assert.equal(transactionView(S('cancelled', 'address_issued'), 'buyer').progress, null);
  assert.equal(transactionView(S('refunded', 'seen'), 'buyer').progress, null);
  assert.equal(transactionView(S('disputed', 'seen'), 'buyer').progress, null);
  const steps = ['created', 'address_issued', 'seen', 'confirmed'].map(
    (paymentState) => transactionView(S('accepted', paymentState), 'buyer').progress,
  );
  assert.deepEqual(steps.map((p) => p.filled), [1, 2, 3, 4]);
  assert.ok(steps.every((p) => p.total === 4));
});

test('the next action is one the real table allows for that side, never another', () => {
  // vendor, new request: accept first, decline second
  let view = transactionView(S('pending'), 'vendor');
  assert.equal(view.primary.action, 'accept_order');
  assert.equal(view.primary.label, 'Accept order');
  assert.deepEqual(view.secondary.map((a) => a.action), ['decline_order']);
  // buyer, request not answered: only cancel
  view = transactionView(S('pending'), 'buyer');
  assert.equal(view.primary, null);
  assert.deepEqual(view.secondary.map((a) => a.action), ['cancel_order']);
  // vendor ships only after payment was seen
  assert.equal(transactionView(S('paid', 'seen'), 'vendor').primary.action, 'mark_shipped');
  assert.notEqual(transactionView(S('paid', 'created'), 'vendor').primary?.action, 'mark_shipped');
  // buyer confirms delivery only when shipped
  view = transactionView(S('shipped', 'confirmed'), 'buyer');
  assert.equal(view.primary.action, 'confirm_delivery');
  assert.deepEqual(view.secondary.map((a) => a.action), ['report_issue']);
  assert.equal(transactionView(S('accepted', 'seen'), 'buyer').primary?.action === 'confirm_delivery', false);
  // sealed deals have no actions at all
  for (const status of ['completed', 'cancelled', 'refunded']) {
    for (const viewer of ['buyer', 'vendor']) {
      const done = transactionView(S(status, 'confirmed'), viewer);
      assert.equal(done.primary, null);
      assert.deepEqual(done.secondary, []);
      assert.equal(done.group, 'done');
    }
  }
});

test('every action on a card is in the real table for that state', () => {
  const statuses = ['pending', 'accepted', 'paid', 'shipped', 'completed', 'cancelled', 'refunded', 'disputed'];
  const payments = ['created', 'address_issued', 'seen', 'confirmed'];
  for (const status of statuses) {
    for (const paymentState of payments) {
      for (const resurrected of [false, true]) {
        for (const viewer of ['buyer', 'vendor']) {
          const view = transactionView(S(status, paymentState, { resurrected }), viewer);
          const ids = [view.primary, ...view.secondary].filter(Boolean).map((a) => a.action);
          assert.equal(ids.length, view.actions.length, `${status}/${paymentState}/${viewer}`);
          assert.deepEqual([...ids].sort(), view.actions.map((a) => a.action).sort());
        }
      }
    }
  }
});

test('a status the table does not know is an error state, not a guess', () => {
  const view = transactionView({ status: 'teleported', paymentState: 'created' }, 'buyer');
  assert.equal(view.unknown, true);
  assert.equal(view.primary, null);
  assert.deepEqual(view.secondary, []);
});

test('orders group by what needs the viewer', () => {
  assert.equal(orderGroupOf(S('pending'), 'vendor'), 'needs_action');
  assert.equal(orderGroupOf(S('pending'), 'buyer'), 'in_progress');
  assert.equal(orderGroupOf(S('accepted', 'address_issued'), 'buyer'), 'needs_action');
  assert.equal(orderGroupOf(S('accepted', 'seen'), 'buyer'), 'in_progress');
  assert.equal(orderGroupOf(S('accepted', 'address_issued'), 'vendor'), 'in_progress');
  assert.equal(orderGroupOf(S('paid', 'seen'), 'vendor'), 'needs_action');
  assert.equal(orderGroupOf(S('paid', 'created'), 'vendor'), 'in_progress');
  assert.equal(orderGroupOf(S('shipped', 'confirmed'), 'buyer'), 'needs_action');
  assert.equal(orderGroupOf(S('shipped', 'confirmed'), 'vendor'), 'in_progress');
  assert.equal(orderGroupOf(S('disputed', 'seen'), 'vendor'), 'needs_action');
  assert.equal(orderGroupOf(S('disputed', 'seen'), 'buyer'), 'in_progress');
  assert.equal(orderGroupOf(S('completed', 'confirmed'), 'buyer'), 'done');
  assert.equal(orderGroupOf(S('refunded', 'seen'), 'vendor'), 'done');
});

test('the bottom bar has the four destinations in the specced order', () => {
  assert.deepEqual(BOTTOM_NAV_ITEMS.map((item) => item.id), ['chats', 'menus', 'orders', 'profile']);
  assert.deepEqual(BOTTOM_NAV_ITEMS.map((item) => item.label), ['Chats', 'Menus', 'Orders', 'Profile']);
  assert.deepEqual(BOTTOM_NAV_ITEMS.filter((item) => item.badge).map((item) => item.id), ['chats', 'orders']);
});

const inside = (rect, vp, margin) => rect.left >= margin - 0.001 && rect.top >= margin - 0.001
  && rect.left + rect.width <= vp.width - margin + 0.001 && rect.top + rect.height <= vp.height - margin + 0.001;

test('the context menu never leaves the screen, at any phone width or bubble position', () => {
  const margin = 8;
  const sizes = { reactions: { width: 280, height: 48 }, list: { width: 208, height: 232 } };
  let cases = 0;
  for (const width of [320, 360, 375, 390, 412]) {
    const vp = { width, height: 700 };
    for (const y of [0, 20, 100, 300, 500, 640, 690]) {
      for (const h of [24, 60, 200, 520]) {
        for (const x of [0, 12, 100, width - 120]) {
          for (const align of ['start', 'end']) {
            const anchor = { x, y, width: 120, height: h };
            const place = placeMenu({ anchor, viewport: vp, margin, gap: 8, align, reactions: sizes.reactions, list: sizes.list });
            cases += 1;
            assert.ok(inside({ ...place.reactions, ...sizes.reactions }, vp, margin), `reactions ${JSON.stringify({ width, anchor, align, place })}`);
            assert.ok(inside({ ...place.list, ...sizes.list }, vp, margin), `list ${JSON.stringify({ width, anchor, align, place })}`);
          }
        }
      }
    }
  }
  assert.ok(cases > 500);
});

test('the reaction row sits above the bubble and the list below it when there is room', () => {
  const place = placeMenu({
    anchor: { x: 40, y: 300, width: 200, height: 60 },
    viewport: { width: 390, height: 800 },
    reactions: { width: 280, height: 48 },
    list: { width: 208, height: 232 },
    gap: 8,
    margin: 8,
    align: 'start',
  });
  assert.equal(place.reactions.top, 300 - 8 - 48);
  assert.equal(place.list.top, 300 + 60 + 8);
  assert.equal(place.list.left, 40);
});

test('a menu keeps clear of the system bars when told about them', () => {
  const place = placeMenu({
    anchor: { x: 20, y: 640, width: 200, height: 40 },
    viewport: { width: 390, height: 780 },
    reactions: { width: 280, height: 48 },
    list: { width: 208, height: 232 },
    safe: { top: 47, bottom: 34 },
    margin: 8,
  });
  assert.ok(place.list.top + 232 <= 780 - 34 - 8);
  assert.ok(place.reactions.top >= 47 + 8);
});

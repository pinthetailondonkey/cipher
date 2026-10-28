import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { defaultLedgerSide, discardRejectedOrder, orderRows, peerRole } from './orderLedger.js';

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

// ————— the screen is wired to these, not to the mode flag —————

test('the orders screen filters by its own view and reads each row\'s direction', () => {
  const screen = read('../components/chat/MyOrders.jsx');
  assert.match(screen, /import \{ defaultLedgerSide, orderRows, peerRole \} from '\.\.\/\.\.\/lib\/orderLedger'/);
  assert.match(screen, /useState\(\(\) => defaultLedgerSide\(isVendor\)\)/);
  assert.match(screen, /orderRows\(rows, \{ side \}\)/);
  assert.match(screen, /peerRole\(isBuyer\)/);
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

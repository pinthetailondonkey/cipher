import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ORDER_ACTIONS, allowedActionsFor, deviceWatchedOrderOf, frozenIssuedMethods, issuedPaymentMethods, newestOwnIssuedMethods, orderActionsFor, orderHasVerifiedReceipt, orderPaymentDetails, orderRecordForReceipt, orderState, reopenedStatus } from './orderActions.js';
import { ORDER_STATUS, ORDER_STATUSES, RECEIPT_OUTCOMES } from './paymentState.js';
import { signReceipt, verifyReceipt as verifyReceipt2 } from './proofOfTrade.js';

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
  const sources = ['../features/chat/useCommerce.js', '../Menus.jsx', '../components/OneTapCheckout.jsx', './proofOfTrade.js'].map(read);
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
  assert.match(bubble, /orderActionsFor\(\{ \.\.\.message, data: content \}, chatMessages, '', activeDm\)/);
});

test('every message action has a way in from the UI, and every menu item has a handler', () => {
  const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const bubble = read('../components/MessageBubble.jsx');
  // The context menu lives on the shared Sheet now; reactions offer there.
  const menuSheet = read('../components/chat/MessageContextMenu.jsx');
  const commands = read('../features/chat/useMessageCommands.js');
  const handled = new Set([...commands.matchAll(/action === '([a-z_]+)'/g)].map((m) => m[1]));
  const menu = new Set([
    ...[bubble, menuSheet].flatMap((source) => [...source.matchAll(/\{ action: '([a-z_]+)', label: '[^']+'/g)].map((m) => m[1])),
    ...[bubble, menuSheet].flatMap((source) => [...source.matchAll(/(?:onAction\?\.|\bact)\('([a-z_]+)'/g)].map((m) => m[1])),
  ]);
  const offered = menu;
  for (const action of handled) assert.ok(offered.has(action), `${action} is handled but nothing offers it`);
  // Forward and Select are the thread shell's own actions, wired through the
  // existing sendDM actor in useThreadActions — never the command handler.
  const threadHandled = new Set(['forward', 'select']);
  for (const action of menu) assert.ok(handled.has(action) || threadHandled.has(action), `${action} is offered but not handled`);
  assert.ok(menu.has('view_vendor') && menu.has('edit_product'));
  const overlays = read('../features/chat/ChatOverlays.jsx');
  assert.match(overlays, /<VendorMenuHome\s+open=\{!!vendorStorefrontPubkey\}/);
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

test('acceptance freezes only the pair this device issued, never the buyer\'s word', () => {
  // security S5 re-attack: a paymentMethods on the fresh received card was
  // authored by whoever sent the order request. Only the card's local patch —
  // this device's own write when it accepted before — can freeze an address,
  // or the vendor's acceptance would adopt and receipt-bind a pair a buyer
  // typed.
  assert.equal(frozenIssuedMethods({ data: { paymentMethods: { btc: 'bc1qattacker' } } }, {}), null);
  assert.deepEqual(frozenIssuedMethods({ localPatch: { paymentMethods: { btc: 'bc1qorder' } } }, {}), { btc: 'bc1qorder', xmr: null });
  // An order parked on the account's shared address does not freeze; a
  // re-accept derives it a fresh address instead of serving shared again.
  // The compare reads an uppercase bech32 twin as the shared address too.
  assert.equal(
    frozenIssuedMethods({ localPatch: { paymentMethods: { btc: 'BC1QSHARED', xmr: '' } } }, { btc: 'bc1qshared', xmr: '' }),
    null,
  );
  // Only the side that matches shared lets go; the other stays frozen.
  assert.deepEqual(
    frozenIssuedMethods(
      { localPatch: { paymentMethods: { btc: 'bc1qshared', xmr: '8sub' } } },
      { btc: 'bc1qshared', xmr: '8xmr' },
    ),
    { btc: null, xmr: '8sub' },
  );
  assert.equal(frozenIssuedMethods(null, {}), null);
});

// S5 re-attack (round three, cross-device): a second device holds neither
// the card's patch nor the first device's derivation slot, so 'nothing
// frozen' would derive a second address while the buyer already paid the
// first. The newest own-sent acceptance update in the chat is the same
// trusted source the chain check reads — the freeze falls back to it.
test('the freeze falls back to the newest own acceptance update for the order', () => {
  const acceptance = update('a1', true, ORDER_STATUS.ACCEPTED, 20, {
    paymentMethods: { btc: 'bc1qorder', xmr: '8order' },
  });
  const otherOrder = { id: 'a0', isSender: true, timestamp: 5, data: { type: 'order_update', orderId: 'order-0', paymentMethods: { btc: 'bc1qother', xmr: '' } } };
  const shipUpdate = update('s1', true, ORDER_STATUS.SHIPPED, 30);
  assert.deepEqual(newestOwnIssuedMethods([acceptance, otherOrder, shipUpdate], {}, 'order-1'), { btc: 'bc1qorder', xmr: '8order' });
  // A wrong-order id derives fresh rather than serving another order's pair.
  assert.equal(newestOwnIssuedMethods([acceptance], {}, 'order-2'), null);
  // Bigger timestamps count as newer even out of order in the list.
  const reissue = update('a2', true, ORDER_STATUS.ACCEPTED, 60, { paymentMethods: { btc: 'bc1qnewer', xmr: '' } });
  assert.deepEqual(newestOwnIssuedMethods([acceptance, reissue], {}, 'order-1'), { btc: 'bc1qnewer', xmr: null });
  // The latest update without a pair does not hide an older issued one; the
  // last pair ever issued wins.
  assert.deepEqual(newestOwnIssuedMethods([acceptance, reissue, shipUpdate], {}, 'order-1'), { btc: 'bc1qnewer', xmr: null });
  // Update id and no orderId field on an old update: only the ones naming
  // this order count.
  assert.deepEqual(
    newestOwnIssuedMethods(
      [{ id: 'a3', isSender: true, timestamp: 70, data: { type: 'order_update', paymentMethods: { btc: 'bc1qnoId' } } }, acceptance],
      {},
      'order-1',
    ),
    { btc: 'bc1qorder', xmr: '8order' },
  );
  // An arm equal to the account's shared address does not freeze — the
  // same case-blind refusal the card patch gets; the other arm still does.
  assert.deepEqual(
    newestOwnIssuedMethods([acceptance], { btc: 'bc1qother', xmr: '8order' }, 'order-1'),
    { btc: 'bc1qorder', xmr: null },
  );
  // Both arms shared: nothing freezes, a fresh derivation serves instead.
  assert.equal(newestOwnIssuedMethods([acceptance], { btc: 'bc1qorder', xmr: '8order' }, 'order-1'), null);
  // Nothing own-sent: derive fresh.
  assert.equal(newestOwnIssuedMethods([update('u9', false, ORDER_STATUS.ACCEPTED, 10, { paymentMethods: { btc: 'bc1qpeer' } })], {}, 'order-1'), null);
  assert.equal(newestOwnIssuedMethods(null, {}, 'order-1'), null);
});

// N1 (round-three re-hack): a buyer's co-signature on a receipt must mean
// this device's own watcher saw the money. The watcher check lands on the
// order card as a local patch; until it has, the vendor's receipt is a
// claim, and a confirmed over a txid that never happened signs nothing.
test('only this device\'s own watcher check lets a receipt attach', () => {
  const card = request(true, {});
  // Nothing checked yet: the gate is shut.
  assert.equal(deviceWatchedOrderOf([card], 'order-1'), false);
  assert.equal(deviceWatchedOrderOf([], 'order-1'), false);
  // A watcher outcome the peer wrote into a received card is not this
  // device's own check.
  const claimed = { ...card, localPatch: undefined };
  const peerClaim = update('u1', false, ORDER_STATUS.PAID, 12, { paymentState: 'confirmed', paymentSeenBy: 'watcher' });
  assert.equal(deviceWatchedOrderOf([claimed, peerClaim], 'order-1'), false);
  // This device's own watcher sight, seen and confirmed both count.
  const seenCard = { ...card, localPatch: { paymentState: 'seen', paymentSeenBy: 'watcher' } };
  const confirmedCard = { ...card, localPatch: { paymentState: 'confirmed', paymentSeenBy: 'watcher' } };
  assert.equal(deviceWatchedOrderOf([seenCard], 'order-1'), true);
  assert.equal(deviceWatchedOrderOf([confirmedCard], 'order-1'), true);
  // Any other written state stays a claim: address_issued is the vendor's
  // acceptance, not the chain's word.
  const issuedCard = { ...card, localPatch: { paymentState: 'address_issued' } };
  assert.equal(deviceWatchedOrderOf([issuedCard], 'order-1'), false);
  // Another order's card cannot light this one.
  const other = { id: 'order-2', isSender: true, timestamp: 5, data: { type: 'order_request' }, localPatch: { paymentState: 'confirmed' } };
  assert.equal(deviceWatchedOrderOf([other, card], 'order-1'), false);
});

// N3 (round-three re-hack): the lifecycle status is the newest claim, so a
// later claim could flip a COMPLETED deal back to 'paid' — with payment
// evidence already earned, mark_shipped reopened on a deal that was over.
// A deal the updates ever sealed stays sealed; the claim shows and the
// shipping lever stays down.
test('a sealed deal cannot be walked back to a shipping decision by a claim', () => {
  const theirs = request(false, {});
  const completed = update('u1', false, ORDER_STATUS.COMPLETED, 12, { paymentState: 'confirmed' });
  // The 'paid' claim after the seal: the display shows it, the lever does
  // not follow.
  const resurrect = update('u2', false, ORDER_STATUS.PAID, 30, { paymentState: 'confirmed' });
  const state = orderState([theirs, completed, resurrect], 'order-1', theirs);
  assert.equal(state.status, ORDER_STATUS.PAID);
  assert.equal(state.resurrected, true);
  assert.deepEqual(names(allowedActionsFor(state, 'vendor')), ['check_chain']);
  // Same for the buyer's card: delivery confirmation does not reopen on
  // the claim.
  const buyerCard = request(true, {});
  const buyerState = orderState(
    [buyerCard, { ...completed, isSender: true }, { ...resurrect, isSender: true }],
    'order-1',
    buyerCard,
  );
  assert.deepEqual(names(allowedActionsFor(buyerState, 'buyer')), ['check_chain', 'report_issue']);
  // The unsealed dispute keeps the S6 resolution both sides rely on: no
  // seal in history, no resurrected mark, resume and refund stay put.
  const dispute = orderState(
    [theirs, update('ud', false, ORDER_STATUS.DISPUTED, 20)],
    'order-1',
    theirs,
  );
  assert.equal(dispute.resurrected, false);
  assert.deepEqual(names(allowedActionsFor(dispute, 'vendor')), ['mark_refunded', 'resume_order']);
  // Refunded and cancelled seal as well; a fresh deal is a fresh order.
  for (const sealing of [ORDER_STATUS.REFUNDED, ORDER_STATUS.CANCELLED]) {
    const state2 = orderState([theirs, update('ux', false, ORDER_STATUS.PAID, 11), update('uy', false, sealing, 12), update('uz', false, ORDER_STATUS.PAID, 30)], 'order-1', theirs);
    assert.equal(state2.resurrected, true);
    assert.deepEqual(names(allowedActionsFor(state2, 'vendor')), ['check_chain']);
  }
  // The seal never blocks the reading a vendor needs: a true completed
  // order stays buttonless, as the table already reads.
  assert.deepEqual(names(allowedActionsFor(orderState([theirs, completed], 'order-1', theirs), 'vendor')), []);
});

test('a never-accepted vendor order builds no receipt record, whatever the peer claims', () => {
  // security F4 re-attack: the newest-wins lifecycle status is a claim. A
  // peer's fake 'paid' update on an order the vendor never accepted, with
  // attacker methods and an attacker amount, must not build the record a
  // receipt could bind to — or this device's signature could be harvested
  // against.
  const victim = request(false, { product: { title: 'Tee', price: '20', currency: 'usd' } });
  const claims = [
    update('u1', false, ORDER_STATUS.ACCEPTED, 20, { coinAmount: '0.00000001', coinCurrency: 'btc', paymentMethods: { btc: 'bc1qattacker' } }),
    update('u2', false, ORDER_STATUS.PAID, 30, { coinAmount: '0.00000001', coinCurrency: 'btc', paymentMethods: { btc: 'bc1qattacker' } }),
  ];
  assert.equal(orderRecordForReceipt([victim, ...claims], 'order-1'), null);
  // One own-sent acceptance — and the record is this device's own write:
  // the peer's later claims name neither the amount nor the address.
  const acceptance = update('u3', true, ORDER_STATUS.ACCEPTED, 40, {
    coinAmount: '0.01', coinCurrency: 'btc', paymentMethods: { btc: 'bc1qvendor' },
  });
  const record = orderRecordForReceipt([victim, ...claims, acceptance], 'order-1');
  assert.deepEqual(
    { coinAmount: record.coinAmount, coinCurrency: record.coinCurrency, issuedAddress: record.issuedAddress, isBuyer: record.isBuyer },
    { coinAmount: '0.01', coinCurrency: 'btc', issuedAddress: 'bc1qvendor', isBuyer: false },
  );
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
  // The vendor's view of the same order: the counterparty initiated it, and
  // the record rests on the vendor's own-sent acceptance.
  assert.equal(orderRecordForReceipt([request(false, {}), { ...acceptance, isSender: true }, { ...paid, isSender: true }], 'order-1').isBuyer, false);
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

// The currency is a string a peer typed. A record only carries an address for
// a coin the issued methods themselves carry: a name that reaches the object's
// prototype would otherwise put a function or an object where an address goes,
// and the receipt path would throw on it instead of refusing the address.
test('a coin name that is not a coin names no issued address on a receipt', () => {
  const paid = (id) => update(id, true, ORDER_STATUS.PAID, 30, {});
  for (const hostile of ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf']) {
    const acceptance = update('u1', true, ORDER_STATUS.ACCEPTED, 20, {
      coinAmount: '0.01', coinCurrency: hostile, paymentMethods: { btc: 'bc1qorder', xmr: '4xmr' },
    });
    const record = orderRecordForReceipt([request(true, {}), acceptance, paid('u2')], 'order-1');
    assert.equal(record.coinCurrency, hostile);
    assert.equal(record.issuedAddress, '', `${hostile} names no address`);
    assert.equal(record.coinAmount, '0.01', `${hostile} still names the amount`);
  }
  // The two real coins still name their own address, and a real coin with no
  // address on the pair still names none.
  for (const coin of ['btc', 'xmr']) {
    const acceptance = update('u1', true, ORDER_STATUS.ACCEPTED, 20, {
      coinAmount: '0.01', coinCurrency: coin, paymentMethods: { btc: 'bc1qorder', xmr: '4xmr' },
    });
    const record = orderRecordForReceipt([request(true, {}), acceptance, paid('u2')], 'order-1');
    assert.equal(record.issuedAddress, coin === 'btc' ? 'bc1qorder' : '4xmr');
  }
  const btcOnly = update('u1', true, ORDER_STATUS.ACCEPTED, 20, {
    coinAmount: '0.01', coinCurrency: 'xmr', paymentMethods: { btc: 'bc1qorder' },
  });
  assert.equal(orderRecordForReceipt([request(true, {}), btcOnly, paid('u2')], 'order-1').issuedAddress, '');
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
  // The request card carries its author's pubkey from the event.
  const theirs = { ...request(false, { status: ORDER_STATUS.PAID }), pubkey: hexOf(schnorr.getPublicKey(buyerKey)) };
  const riding = update('u4', false, ORDER_STATUS.PAID, 14, { paymentState: 'confirmed', paymentSeenBy: 'watcher', receipt: signed });
  const state = orderState([theirs, riding], 'order-1', theirs);
  assert.equal(state.paymentState, 'confirmed');
  assert.deepEqual(names(allowedActionsFor(state, 'vendor')), ['mark_shipped']);
  // A receipt whose two parties are a set of keys the attacker holds both
  // verifies — and adopts nothing, because neither is a party of this chat.
  // (security F7)
  const evilA = schnorr.utils.randomSecretKey();
  const evilB = schnorr.utils.randomSecretKey();
  const evilBody = { ...body, buyer: hexOf(schnorr.getPublicKey(evilA)), vendor: hexOf(schnorr.getPublicKey(evilB)) };
  const evilReceipt = signReceipt(evilB, evilBody, signReceipt(evilA, evilBody));
  assert.equal(verifyReceipt2(evilReceipt), true);
  assert.equal(
    orderState([theirs, update('u7', false, ORDER_STATUS.PAID, 17, { receipt: evilReceipt })], 'order-1', theirs).paymentState,
    'created',
  );
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
  // what this device has earned, never what an update asserts. The one thing
  // a buyer does earn from a received update is the address the vendor issued
  // — the same update the pair above was just read from (F-BC1) — so the
  // state stops at address_issued and the peer's watcher word is still nil.
  assert.equal(details.paymentState, 'address_issued');
  assert.equal(details.paymentSeenBy, '');
  assert.equal(details.status, 'paid');
  // The acceptance carries the issuance date of the order's address, so the
  // chain check can refuse a transfer dated before the address existed.
  assert.equal(orderPaymentDetails([buyerCard, update('ui', false, 'accepted', 12, { issuedAt: 1234 })], 'order-1').issuedAt, 1234);
  // The vendor's own view of the same order: the record rests on the
  // vendor's own acceptance. A received acceptance alone is the vendor's
  // word to the buyer — it builds no record on the vendor side to bind.
  const vendorOwn = { ...acceptance, isSender: true };
  assert.equal(orderRecordForReceipt([request(false, {}), vendorOwn, paid], 'order-1').issuedAddress, 'bc1qorder');
  assert.equal(orderRecordForReceipt([request(false, {}), acceptance, paid], 'order-1'), null);
  // The vendor's card carries the same acceptance as its own patch fallback.
  const vendorCard = request(false, { paymentMethods: { btc: 'bc1qcard', xmr: '' }, coinAmount: '0.02', coinCurrency: 'btc' });
  assert.deepEqual(orderPaymentDetails([vendorCard, acceptance], 'order-1').paymentMethods, { btc: 'bc1qorder', xmr: '' });
  // Nothing to read: no request card, no details.
  assert.equal(orderPaymentDetails([acceptance], 'order-2'), null);
  assert.equal(orderPaymentDetails([], 'order-1'), null);
});

// N2 (round-three re-hack): the ledger's gates degenerated on the buyer's
// own card — request.pubkey IS the buyer there, so the chat compare built
// [buyer, buyer] and a genuinely two-signed receipt never lit the ✓. The
// chat pair now resolves from the caller's hand or the chat's own messages.
test('a real countersigned receipt lights the buyer\'s own ledger row', () => {
  const buyerKey = schnorr.utils.randomSecretKey();
  const vendorKey = schnorr.utils.randomSecretKey();
  const buyer = hexOf(schnorr.getPublicKey(buyerKey));
  const vendor = hexOf(schnorr.getPublicKey(vendorKey));
  const body = {
    orderId: 'order-1',
    buyer,
    vendor,
    currency: 'xmr',
    address: '8secret',
    amount: '1',
    txid: 'aa',
    at: 1_700_000_000,
    outcome: 'confirmed',
  };
  const signed = signReceipt(vendorKey, body, signReceipt(buyerKey, body));
  // The buyer's own sent card: pubkey is the buyer, the degenerate shape.
  const mine = { ...request(true, { status: ORDER_STATUS.PAID }), pubkey: buyer };
  const receipted = (id, ts, receipt) => ({ id, isSender: false, pubkey: vendor, timestamp: ts, data: { type: 'order_update', orderId: 'order-1', status: ORDER_STATUS.PAID, receipt } });
  const riding = receipted('u4', 14, signed);
  // The chat peer named by hand, the way MyOrders rows and the thread badge
  // name it, and the receipt adopts.
  assert.equal(orderHasVerifiedReceipt([mine, riding], 'order-1', mine, buyer, vendor), true);
  const state = orderState([mine, riding], 'order-1', mine, buyer, vendor);
  assert.equal(state.paymentState, 'confirmed');
  // And with no caller-supplied peer at all, the chat's own messages still
  // name the two sides: one sent message (the buyer), one received (vendor).
  assert.equal(orderState([mine, riding], 'order-1', mine).paymentState, 'confirmed');
  assert.equal(orderHasVerifiedReceipt([mine, riding], 'order-1', mine), true);
  // The degenerate read the fix replaced: before, [buyer, buyer] never
  // matched and a forged stranger receipt gains nothing either way.
  const evilBody = { ...body, buyer: vendor, vendor: vendor };
  const evil = signReceipt(vendorKey, evilBody, signReceipt(vendorKey, evilBody));
  assert.equal(orderHasVerifiedReceipt([mine, receipted('u9', 20, evil)], 'order-1', mine, buyer, vendor), false);
  assert.equal(orderState([mine, receipted('u9', 20, evil)], 'order-1', mine).paymentState, 'created');
});

// F-BC1: the buyer's chain check could never move. A vendor's acceptance
// carries paymentState 'address_issued' and the pair on its own data, but the
// buyer's reader adopted only a localPatch from a received update — a field
// only the receiver writes — so the buyer sat at 'created' and the walk
// (created → address_issued → seen → confirmed) had no first step. The one
// adoption added here takes the vendor's issued address and nothing else.
test('F-BC1: a buyer adopts the address a vendor issued, and nothing further', () => {
  const buyer = 'b'.repeat(64);
  const vendor = 'c'.repeat(64);
  const ADDR = 'bc1qfb1probe';
  const NOW = 1_793_000_000;
  // The buyer's own sent request, as it is stored on the buyer's device.
  const mine = { id: 'order-1', isSender: true, timestamp: NOW, pubkey: vendor, chatId: vendor,
    data: { type: 'order_request', status: ORDER_STATUS.PENDING, paymentState: 'created', product: { title: 'Washer', priceUsd: '24.00', currency: 'USD' } } };
  // Exactly what useCommerce sends as the acceptance: the pair and its state
  // on the update's own data.
  const acceptance = (data = {}) => ({ id: 'acc-1', isSender: false, timestamp: NOW + 60, pubkey: vendor, chatId: vendor,
    data: { type: 'order_update', orderId: 'order-1', status: ORDER_STATUS.ACCEPTED, paymentState: 'address_issued',
      paymentMethods: { btc: ADDR }, coinAmount: '0.001', coinCurrency: 'btc', issuedAt: NOW + 55, ...data } });

  // (a) the repro: the buyer reaches address_issued, from the same update the
  // details are read from — the state and the details cannot disagree.
  const state = orderState([mine, acceptance()], 'order-1', mine, buyer, vendor);
  assert.equal(state.paymentState, 'address_issued');
  const details = orderPaymentDetails([mine, acceptance()], 'order-1', buyer, vendor);
  assert.equal(details.paymentState, 'address_issued');
  assert.deepEqual(details.paymentMethods, { btc: ADDR });
  assert.equal(details.coinCurrency, 'btc');
  assert.equal(details.coinAmount, '0.001');
  assert.equal(details.issuedAt, NOW + 55);

  // (b) a peer's greedier claim with a valid pair moves nobody further: seen,
  // confirmed and paymentSeenBy stay this device's own facts.
  for (const claim of ['seen', 'confirmed']) {
    const greedy = orderState([mine, acceptance({ paymentState: claim, paymentSeenBy: 'watcher' })], 'order-1', mine, buyer, vendor);
    assert.equal(greedy.paymentState, 'address_issued', `${claim} does not get adopted`);
    assert.equal(greedy.paymentSeenBy, '');
  }

  // (c) a claim with no usable pair is not an issued address at all.
  for (const methods of [undefined, null, {}, { btc: '' }, { btc: '   ' }, 'bc1qfb1probe']) {
    const claimed = orderState([mine, acceptance({ paymentMethods: methods })], 'order-1', mine, buyer, vendor);
    assert.equal(claimed.paymentState, 'created', `no pair (${JSON.stringify(methods)}) issues nothing`);
  }
  // A state below address_issued is not an issuance either.
  assert.equal(orderState([mine, acceptance({ paymentState: 'created' })], 'order-1', mine, buyer, vendor).paymentState, 'created');
  // And an update with no order data at all changes nothing.
  assert.equal(orderState([mine, { id: 'u0', isSender: false, timestamp: NOW + 1, data: null }], 'order-1', mine, buyer, vendor).paymentState, 'created');

  // (d) the vendor side is unmoved: a pair a peer typed into an update it sent
  // is the peer's word, and the vendor never accepted this order.
  const vendorCard = { ...mine, isSender: false };
  const buyersUpdate = { ...acceptance(), pubkey: buyer, isSender: false };
  assert.equal(orderState([vendorCard, buyersUpdate], 'order-1', vendorCard, vendor, buyer).paymentState, 'created');

  // A later vendor update with no pair cannot erase what the acceptance put
  // there — adoption is the best evidence over every message, not the newest.
  const later = { id: 'u2', isSender: false, timestamp: NOW + 120, pubkey: vendor,
    data: { type: 'order_update', orderId: 'order-1', status: ORDER_STATUS.SHIPPED } };
  assert.equal(orderState([mine, acceptance(), later], 'order-1', mine, buyer, vendor).paymentState, 'address_issued');

  // The buyer's own watcher write still walks the chain from there, and the
  // acceptance's row itself is the one the details read.
  const walked = { ...mine, localPatch: { paymentState: 'seen', paymentSeenBy: 'watcher' } };
  assert.equal(orderState([walked, acceptance()], 'order-1', walked, buyer, vendor).paymentState, 'seen');

  // (f) the pair must pay on the coin the update says it issued for. An
  // update claiming xmr with only a btc pair issued nothing the check could
  // pay: the details reader takes the update's xmr and finds no address, so
  // the card would claim a state its own check can never walk. (AUDITOR)
  const mismatched = [mine, acceptance({ coinCurrency: 'xmr', paymentMethods: { btc: ADDR } })];
  assert.equal(orderState(mismatched, 'order-1', mine, buyer, vendor).paymentState, 'created');
  assert.equal(orderPaymentDetails(mismatched, 'order-1', buyer, vendor).coinCurrency, 'xmr');
  // The same pair for the coin it names still lifts, whatever its case.
  assert.equal(orderState([mine, acceptance({ coinCurrency: 'BTC' })], 'order-1', mine, buyer, vendor).paymentState, 'address_issued');
  const xmrPair = acceptance({ coinCurrency: 'xmr', paymentMethods: { xmr: '4fb1probe' }, coinAmount: '0.5' });
  assert.equal(orderState([mine, xmrPair], 'order-1', mine, buyer, vendor).paymentState, 'address_issued');
  assert.equal(orderPaymentDetails([mine, xmrPair], 'order-1', buyer, vendor).paymentMethods.xmr, '4fb1probe');
  // An update that names no coin issues nothing, even with a pair on it: the
  // lift names one coin or it names none.
  assert.equal(orderState([mine, acceptance({ coinCurrency: '' })], 'order-1', mine, buyer, vendor).paymentState, 'created');
  // The coin name is the sender's. A name that resolves on every object must
  // not pass for an issued address: only the pair's own coins count. (AUDITOR,
  // executed: these four lifted 'created' -> 'address_issued' before the guard)
  for (const hostile of ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf']) {
    const claimed = orderState([mine, acceptance({ coinCurrency: hostile })], 'order-1', mine, buyer, vendor);
    assert.equal(claimed.paymentState, 'created', `coin name ${hostile} issues nothing`);
  }
  // A real coin still lifts, and the name is normalised before the lookup:
  // 'BTC' and ' btc ' are the same coin as 'btc'.
  assert.equal(orderState([mine, acceptance({ coinCurrency: 'btc ' })], 'order-1', mine, buyer, vendor).paymentState, 'address_issued');
  // A real coin with no pair for it issues nothing.
  assert.equal(orderState([mine, acceptance({ coinCurrency: 'xmr' })], 'order-1', mine, buyer, vendor).paymentState, 'created');
});

// F-BC1 control (e): the verified-receipt arm is untouched by the redesign.
// It is the terminal artifact both keys signed after a real watcher report,
// so it still moves the payment, and a receipt that fails verification still
// moves nothing.
test('F-BC1: the verified-receipt arm behaves exactly as before', () => {
  const buyerKey = schnorr.utils.randomSecretKey();
  const vendorKey = schnorr.utils.randomSecretKey();
  const buyer = hexOf(schnorr.getPublicKey(buyerKey));
  const vendor = hexOf(schnorr.getPublicKey(vendorKey));
  const body = { orderId: 'order-1', buyer, vendor, currency: 'btc', address: 'bc1qfb1probe', amount: '0.001', txid: 'aa', at: 1_700_000_000, outcome: 'confirmed' };
  const signed = signReceipt(vendorKey, body, signReceipt(buyerKey, body));
  const mine = { id: 'order-1', isSender: true, timestamp: 10, pubkey: vendor, chatId: vendor,
    data: { type: 'order_request', status: ORDER_STATUS.PENDING, paymentState: 'created', product: { title: 'Washer' } } };
  const riding = { id: 'u4', isSender: false, timestamp: 14, pubkey: vendor, chatId: vendor,
    data: { type: 'order_update', orderId: 'order-1', status: ORDER_STATUS.PAID, receipt: signed } };
  assert.equal(orderState([mine, riding], 'order-1', mine, buyer, vendor).paymentState, 'confirmed');
  const tampered = { ...riding, data: { ...riding.data, receipt: { ...signed, body: { ...signed.body, amount: '9' } } } };
  assert.equal(orderState([mine, tampered], 'order-1', mine, buyer, vendor).paymentState, 'created');
});

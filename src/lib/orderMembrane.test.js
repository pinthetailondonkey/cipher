import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderMembrane, MemoryJournal } from './orderMembrane.js';

// The order membrane, exercised against Cipher's real payment rules. One
// order, its whole lifecycle, and the attack classes the lab caught. The
// policy lives in paymentState.js; this suite proves the wall around it.

const TXID = 'a'.repeat(64);

function accept(revision) {
  return {
    type: 'accept_order',
    expectedRevision: revision,
    currency: 'xmr',
    coinAmount: '0.5', // whole coins, never finer than piconero
    issuedAt: 1700000000,
  };
}

function watcherNotice(revision, confirmations, amount = '0.5') {
  return {
    type: 'watcher_report',
    expectedRevision: revision,
    report: { source: 'watcher', txid: TXID, confirmations, amount },
    watcherUrl: 'membrane://watcher',
  };
}

function newOrder({ currency = 'xmr', journal } = {}) {
  return new OrderMembrane('ord7', currency, journal);
}

test('the whole lifecycle walks the one door: accepted, seen, confirmed, paid', () => {
  const app = newOrder();
  const a1 = app.admit({ schemaVersion: 1, operationId: 'op-accept', principal: 'vendor', payload: accept(0) });
  assert.equal(a1.status, 'accepted');
  assert.equal(a1.revision, 1);
  let s = app.summary();
  assert.equal(s.status, 'accepted');
  assert.equal(s.paymentState, 'address_issued');

  let a2 = app.admit({ schemaVersion: 1, operationId: 'op-see', principal: 'watcher', payload: watcherNotice(1, 1) });
  assert.equal(a2.status, 'accepted');
  assert.equal(app.summary().paymentState, 'seen');

  a2 = app.admit({ schemaVersion: 1, operationId: 'op-confirm', principal: 'watcher', payload: watcherNotice(2, 10) });
  assert.equal(a2.status, 'accepted');
  s = app.summary();
  assert.equal(s.paymentState, 'confirmed');
  assert.equal(s.status, 'paid');
  assert.equal(s.paid, true);
});

test('a duplicate delivery is idempotent; a replayed id with different payload is a conflict', () => {
  const app = newOrder();
  app.admit({ schemaVersion: 1, operationId: 'op-accept', principal: 'vendor', payload: accept(0) });
  const before = app.summary();

  // verbatim replay: no second write, no bump
  const dup = app.admit({ schemaVersion: 1, operationId: 'op-accept', principal: 'vendor', payload: accept(0) });
  assert.equal(dup.status, 'duplicate');
  assert.equal(app.summary().revision, before.revision);

  // the same opId arriving later with a different order of business: the
  // relay must never silently swallow it
  const conflict = app.admit({
    schemaVersion: 1,
    operationId: 'op-accept',
    principal: 'vendor',
    payload: { ...accept(1), coinAmount: '999' },
  });
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(app.summary(), before);
});

test('a payment that already moved cannot move again on a replayed txid', () => {
  const app = newOrder();
  app.admit({ schemaVersion: 1, operationId: 'op-accept', principal: 'vendor', payload: accept(0) });
  app.admit({ schemaVersion: 1, operationId: 'op-see', principal: 'watcher', payload: watcherNotice(1, 1) });
  // the same txid replayed under a FRESH operation id: applyWatcherReport
  // refuses the double-move
  const again = app.admit({ schemaVersion: 1, operationId: 'op-see-2', principal: 'watcher', payload: watcherNotice(2, 1) });
  assert.equal(again.status, 'rejected');
  assert.equal(again.reason, 'watcher_refused');
  const s = app.summary();
  assert.equal(s.revision, 2);
  assert.equal(s.paymentState, 'seen');
});

test('no principal speaks outside its table; attacker says nothing', () => {
  const app = newOrder();
  // a peer "confirming" its own payment: the F7 class
  const forged = app.admit({
    schemaVersion: 1,
    operationId: 'op-fake',
    principal: 'attacker',
    payload: { type: 'watcher_report', expectedRevision: 0, report: { source: 'watcher', txid: TXID, confirmations: 99 } },
  });
  assert.equal(forged.status, 'rejected');
  assert.equal(forged.reason, 'authority');
  assert.equal(app.summary().paymentState, 'created');

  // the buyer cannot write the vendor's acceptance
  const buyerAccept = app.admit({ schemaVersion: 1, operationId: 'op-accept', principal: 'buyer', payload: accept(0) });
  assert.equal(buyerAccept.status, 'rejected');
  assert.equal(buyerAccept.reason, 'authority');
  assert.equal(app.summary().status, 'pending');
});

test('stale revision is refused; the live revision still applies the legal move', () => {
  const app = newOrder();
  app.admit({ schemaVersion: 1, operationId: 'op-accept', principal: 'vendor', payload: accept(0) });
  const stale = app.admit({ schemaVersion: 1, operationId: 'op-ship', principal: 'vendor', payload: { type: 'mark_shipped', expectedRevision: 0 } });
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.reason, 'stale');
  // retrying with the live revision is not enough by itself: shipped needs
  // paid, and this order is not paid yet
  const early = app.admit({ schemaVersion: 1, operationId: 'op-ship', principal: 'vendor', payload: { type: 'mark_shipped', expectedRevision: 1 } });
  assert.equal(early.status, 'rejected');
  assert.equal(early.reason, 'invalid_transition');
  // and a move the table allows lands on the retry
  const ok = app.admit({ schemaVersion: 1, operationId: 'op-cancel', principal: 'vendor', payload: { type: 'cancel_order', expectedRevision: 1 } });
  assert.equal(ok.status, 'accepted');
  assert.equal(ok.revision, 2);
  assert.equal(app.summary().status, 'cancelled');
});

test('skipping a step is refused by Cipher rules; authority and status stay forward-only', () => {
  const app = newOrder();
  // nothing was accepted and no address was issued, so a watcher report has
  // nothing to see: Cipher refuses to confirm a payment that never walked
  // the issuance step. (One threshold-passing report may carry seen AND
  // confirmed together once issued -- that is Cipher's own walk -- but it
  // never starts from created.)
  const ghost = app.admit({ schemaVersion: 1, operationId: 'op-ghost', principal: 'watcher', payload: watcherNotice(0, 10) });
  assert.equal(ghost.status, 'rejected');
  assert.equal(app.summary().paymentState, 'created');
  assert.equal(app.summary().revision, 0);
  // shipped before paid at the status layer: orderActions table refuses
  const earlyShip = app.admit({ schemaVersion: 1, operationId: 'op-ship', principal: 'vendor', payload: { type: 'mark_shipped', expectedRevision: 0 } });
  assert.equal(earlyShip.status, 'rejected');
  assert.equal(earlyShip.reason, 'invalid_transition');
  assert.equal(app.summary().status, 'pending');
});

test('a short payment never confirms: the piconero class cannot confirm half an order', () => {
  const app = newOrder();
  app.admit({ schemaVersion: 1, operationId: 'op-accept', principal: 'vendor', payload: accept(0) });
  // one piconero tries to pay a 0.5 XMR order
  const sneak = app.admit({
    schemaVersion: 1,
    operationId: 'op-short',
    principal: 'watcher',
    payload: watcherNotice(1, 12, '0.000000000001'),
  });
  assert.equal(sneak.status, 'rejected');
  assert.equal(sneak.reason, 'watcher_refused');
  assert.equal(app.summary().paymentState, 'address_issued');
});

test('a crash before the record lands leaves both disk and ram unchanged', () => {
  const journal = new MemoryJournal();
  const app = newOrder({ journal });
  const rawAppend = journal.append.bind(journal);
  journal.append = () => { throw new Error('crash: before_write'); };
  const crashed = app.admit({ schemaVersion: 1, operationId: 'op-accept', principal: 'vendor', payload: accept(0) });
  assert.equal(crashed.status, 'crashed');
  journal.append = rawAppend;
  assert.equal(app.summary().status, 'pending'); // ram unchanged
  // the same op still applies after the crash
  const retried = app.admit({ schemaVersion: 1, operationId: 'op-accept', principal: 'vendor', payload: accept(0) });
  assert.equal(retried.status, 'accepted');
});

test('a torn mid-write tail is dropped on recovery; nothing untrusted is adopted', () => {
  const journal = new MemoryJournal();
  const app = newOrder({ journal });
  app.admit({ schemaVersion: 1, operationId: 'op-accept', principal: 'vendor', payload: accept(0) });
  app.admit({ schemaVersion: 1, operationId: 'op-see', principal: 'watcher', payload: watcherNotice(1, 1) });
  // simulate a torn write: half of a real third line, no closing brace --
  // only the appended line is torn; the trusted prefix is untouched
  const tornTail = JSON.stringify(watcherNotice(2, 10)).slice(0, 40);
  const reopened = new OrderMembrane('ord7', 'xmr', new RecoveryJournal(journal.raw() + tornTail));
  assert.equal(reopened.summary().paymentState, 'seen'); // trusted prefix intact
  assert.equal(reopened.summary().revision, 2);
  assert.deepEqual(reopened.recoveryAnomalies, ['corrupt_line']);
  // appends resume from the kept prefix -- the healed journal takes new writes
  const after = reopened.admit({ schemaVersion: 1, operationId: 'op-confirm', principal: 'watcher', payload: watcherNotice(2, 10) });
  assert.equal(after.status, 'accepted');
  assert.equal(reopened.summary().paymentState, 'confirmed');
});

test('a reopened membrane replays to the same state through the same door', () => {
  const journal = new MemoryJournal();
  const app = newOrder({ journal });
  app.admit({ schemaVersion: 1, operationId: 'op-accept', principal: 'vendor', payload: accept(0) });
  app.admit({ schemaVersion: 1, operationId: 'op-see', principal: 'watcher', payload: watcherNotice(1, 1) });
  app.admit({ schemaVersion: 1, operationId: 'op-confirm', principal: 'watcher', payload: watcherNotice(2, 10) });
  app.admit({ schemaVersion: 1, operationId: 'op-ship', principal: 'vendor', payload: { type: 'mark_shipped', expectedRevision: 3 } });
  const live = app.summary();
  const reopened = new OrderMembrane('ord7', 'xmr', journal);
  assert.deepEqual(reopened.summary(), live);
  assert.deepEqual(reopened.recoveryAnomalies, []);
  // a replayed id after reopen still dedups against the durable table
  const replay = reopened.admit({ schemaVersion: 1, operationId: 'op-confirm', principal: 'watcher', payload: watcherNotice(2, 10) });
  assert.equal(replay.status, 'duplicate');
});

test('a tampered suffix fails the door check, gets dropped, and the trusted state never adopts it', () => {
  const journal = new MemoryJournal();
  const app = newOrder({ journal });
  app.admit({ schemaVersion: 1, operationId: 'op-accept', principal: 'vendor', payload: accept(0) });
  // an attacker appends a forged "confirmed" line: right shape, right seq,
  // wrong digest -- nothing about it is trusted
  const forged = JSON.stringify({
    kind: 'commit', schemaVersion: 1, orderId: 'ord7', seq: 2,
    opId: 'forged-1', digest: '0000000000000000', principal: 'watcher',
    op: watcherNotice(1, 999),
  });
  const reopened = new OrderMembrane('ord7', 'xmr', new RecoveryJournal(journal.raw() + forged + '\n'));
  assert.equal(reopened.summary().paymentState, 'address_issued');
  assert.equal(reopened.summary().revision, 1);
  assert.equal(reopened.recoveryAnomalies.length, 1);
  assert.equal(reopened.recoveryAnomalies[0], 'digest_mismatch');
});

// A journal that replays from saved raw text, standing in for what the
// browser would hold. readAllDetailed parses per line; a blank or torn tail
// is unparseable, which recovery refuses.
class RecoveryJournal {
  #lines;
  constructor(text) {
    this.#lines = String(text ?? '').split('\n').filter((line) => line !== '');
  }
  append(entry) {
    this.#lines.push(JSON.stringify(entry));
  }
  readAllDetailed() {
    return this.#lines.map((raw) => {
      try {
        return { raw, ok: true, entry: JSON.parse(raw) };
      } catch {
        return { raw, ok: false };
      }
    });
  }
  rewrite(keptCount) {
    this.#lines = this.#lines.slice(0, keptCount);
  }
}

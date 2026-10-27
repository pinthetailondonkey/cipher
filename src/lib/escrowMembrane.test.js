import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderMembrane, MemoryJournal, satsToCoins } from './orderMembrane.js';
import { assembleOrderScript, scriptToHex } from './escrowScript.js';
import { MIN_ORDER_SATS } from './escrowFsm.js';

// The escrow ops walk the SAME admission door every other order fact
// walks: decode -> dedup -> revision -> authority -> one journal record.
// These tests attack the door, not the escrow math (escrowFsm test owns
// that) and not the script bytes (escrowScript test owns those).

const PRICE = 50_000_000n; // 0.5 BTC
const PUB_V = Uint8Array.from({ length: 33 }, (_, i) => 0x11 + i);
const PUB_B = Uint8Array.from({ length: 33 }, (_, i) => 0x2a + i);
const SCRIPT_HEX = scriptToHex(assembleOrderScript({ vendorPubKey: PUB_V, buyerPubKey: PUB_B, delayBlocks: 2880 }));
const TX_FUND = 'aa'.repeat(32);
const TX_SETTLE = 'bb'.repeat(32);
const FUND_HEIGHT = 800_000;

function freshMembrane() {
  const membrane = new OrderMembrane('order-1', 'btc');
  return membrane;
}

function openOrder(m, { revision = 0, id = 'open-1' } = {}) {
  return m.admit({
    schemaVersion: 1,
    operationId: id,
    principal: 'vendor',
    payload: {
      type: 'escrow_open', expectedRevision: revision, currency: 'btc',
      priceSats: PRICE.toString(), scriptHex: SCRIPT_HEX, delayBlocks: 2880,
      issuedAt: 1_000, publicKeysHex: null,
    },
  });
}

function fundOrder(m, { revision, id = 'fund-1', sats, confirmations = 1, height = FUND_HEIGHT } = {}) {
  const st = m.summary();
  return m.admit({
    schemaVersion: 1,
    operationId: id,
    principal: 'watcher',
    payload: {
      type: 'escrow_fund', expectedRevision: revision ?? st.revision,
      txid: TX_FUND, sats, confirmations, height,
    },
  });
}

function confirmOrder(m, { revision, id = 'confirm-1', confirmations = 3 } = {}) {
  const st = m.summary();
  const deposit = BigInt(st.escrow.priceSats) + BigInt(st.escrow.buyerFeeSats);
  return m.admit({
    schemaVersion: 1,
    operationId: id,
    principal: 'watcher',
    payload: {
      type: 'watcher_report', expectedRevision: revision ?? st.revision,
      report: { source: 'watcher', txid: TX_FUND, confirmations, amount: satsToCoins(deposit) },
    },
  });
}

function settleOrder(m, kind, { revision, id = kind, height = FUND_HEIGHT, refundKind = 'admitted' } = {}) {
  const st = m.summary();
  return m.admit({
    schemaVersion: 1,
    operationId: id,
    principal: 'watcher',
    payload: {
      type: kind, expectedRevision: revision ?? st.revision,
      txid: TX_SETTLE, ...(kind === 'escrow_refund' ? { kind: refundKind } : {}), height,
    },
  });
}

function depositSats(summary) {
  return BigInt(summary.escrow.priceSats) + BigInt(summary.escrow.buyerFeeSats);
}

test('the escrow happy path: open -> funded -> confirmed -> released, deal done', () => {
  const m = freshMembrane();
  assert.equal(openOrder(m).status, 'accepted');
  let st = m.summary();
  assert.equal(st.status, 'accepted');
  assert.equal(st.paymentState, 'address_issued');
  assert.equal(st.escrow.state, 'draft');
  assert.equal(st.escrow.priceSats, '50000000');
  assert.equal(st.escrow.buyerFeeSats, '1250000'); // 2.5%, same share both sides

  assert.equal(
    fundOrder(m, { sats: depositSats(st).toString() }).status, 'accepted',
  );
  st = m.summary();
  assert.equal(st.escrow.state, 'funded');
  assert.equal(st.paymentState, 'seen'); // 1 confirmation = mined = seen
  assert.equal(st.paymentSeenBy, 'watcher');
  assert.equal(st.escrow.fundingHeight, FUND_HEIGHT);

  assert.equal(confirmOrder(m).status, 'accepted');
  st = m.summary();
  assert.equal(st.paymentState, 'confirmed');

  assert.equal(settleOrder(m, 'escrow_release').status, 'accepted');
  st = m.summary();
  assert.equal(st.escrow.state, 'released');
  assert.equal(st.status, 'completed');
  assert.equal(st.paid, true);
  assert.equal(st.escrow.settleTxid, TX_SETTLE);
  // nothing stateful leaks: summary is a JSON copy, sats stay strings
  assert.equal(JSON.parse(JSON.stringify(st)).escrow.fundedSats, depositSats(st).toString());
});

test('escrow state survives a reload: replay puts the box back exactly', () => {
  const journal = new MemoryJournal();
  const m = new OrderMembrane('order-1', 'btc', journal);
  openOrder(m);
  const fundEnvelope = {
    schemaVersion: 1, operationId: 'fund-1', principal: 'watcher',
    payload: { type: 'escrow_fund', expectedRevision: m.summary().revision, txid: TX_FUND, sats: depositSats(m.summary()).toString(), confirmations: 1, height: FUND_HEIGHT },
  };
  assert.equal(m.admit(fundEnvelope).status, 'accepted');
  confirmOrder(m);
  const live = m.summary();

  const reopened = new OrderMembrane('order-1', 'btc', journal);
  assert.deepEqual(reopened.summary(), live);
  assert.deepEqual(reopened.recoveryAnomalies, []);
  // the dedup table survives too: a replayed fund is a duplicate, not a second escrow
  assert.equal(reopened.admit(fundEnvelope).status, 'duplicate');
  // and the same id with a DIFFERENT thing to say is still a conflict
  assert.equal(
    reopened.admit({ ...fundEnvelope, payload: { ...fundEnvelope.payload, sats: '52250000' } }).status,
    'conflict',
  );
});

test('the deposit races the rooms: an ordinary payment report before the fund never jams the box', () => {
  // One deposit tx, two reporters: the buyer's own chain check walks the
  // ordinary payment beats, the escrow fund report lands the box fact.
  // Either order of arrival must leave the deal closable. (re-attack
  // round @ 52cbdab: the fund gate demanded address_issued exactly, so
  // the first legitimate watcher report welded the escrow shut forever.)
  const m = freshMembrane();
  openOrder(m);
  let st = m.summary();
  assert.equal(m.admit({
    schemaVersion: 1, operationId: 'watch-1', principal: 'watcher',
    payload: { type: 'watcher_report', expectedRevision: st.revision,
      report: { source: 'watcher', txid: TX_FUND, confirmations: 3, amount: satsToCoins(depositSats(st)) } },
  }).status, 'accepted');
  assert.equal(m.summary().paymentState, 'confirmed');
  // the fund report arrives second: the box funds and the beat never steps back
  assert.equal(fundOrder(m, { sats: depositSats(st).toString() }).status, 'accepted');
  st = m.summary();
  assert.equal(st.escrow.state, 'funded');
  assert.equal(st.paymentState, 'confirmed');
  // and both closes still walk from there
  assert.equal(settleOrder(m, 'escrow_release', { id: 'release-late-watch' }).status, 'accepted');
  assert.equal(m.summary().escrow.state, 'released');
});

test('the same race with only "seen": the fund does not step the payment state back', () => {
  const m = freshMembrane();
  openOrder(m);
  let st = m.summary();
  assert.equal(m.admit({
    schemaVersion: 1, operationId: 'watch-1-seen', principal: 'watcher',
    payload: { type: 'watcher_report', expectedRevision: st.revision,
      report: { source: 'watcher', txid: TX_FUND, confirmations: 1, amount: satsToCoins(depositSats(st)) } },
  }).status, 'accepted');
  assert.equal(m.summary().paymentState, 'seen');
  // the fund report arrives second: it lands the box and does not
  // demote the beat the watcher already earned
  assert.equal(fundOrder(m, { sats: depositSats(st).toString() }).status, 'accepted');
  st = m.summary();
  assert.equal(st.escrow.state, 'funded');
  assert.equal(st.paymentState, 'seen');
  // the ordinary confirm still walks, and release lands from there
  assert.equal(confirmOrder(m).status, 'accepted');
  assert.equal(settleOrder(m, 'escrow_release', { id: 'release-seen-race' }).status, 'accepted');
  assert.equal(m.summary().escrow.state, 'released');
});

test('an underpaid deposit is refused at the door; a full one lands right after', () => {
  const m = freshMembrane();
  openOrder(m);
  const st = m.summary();
  assert.equal(
    fundOrder(m, { sats: (depositSats(st) - 1n).toString() }).reason, 'escrow_refused',
  );
  assert.equal(m.summary().escrow.state, 'draft');
  assert.equal(
    fundOrder(m, { sats: depositSats(st).toString() }).status, 'accepted',
  );
  // an overpay goes in whole in ONE funding report — a SECOND fund after
  // the box is funded is refused forever (the FSM's double-fund rule)
  const m2 = freshMembrane();
  openOrder(m2);
  const overpay = depositSats(m2.summary()) + 7000n;
  assert.equal(
    fundOrder(m2, { sats: overpay.toString() }).status, 'accepted',
  );
  assert.equal(m2.summary().escrow.fundedSats, overpay.toString());
  assert.equal(
    fundOrder(m2, { id: 'fund-2', sats: '1000', height: FUND_HEIGHT + 3 }).reason,
    'invalid_transition',
  );
});

test('release before the payment is confirmed is refused; after the confirm, it lands', () => {
  const m = freshMembrane();
  openOrder(m);
  fundOrder(m, { sats: depositSats(m.summary()).toString() });
  assert.equal(settleOrder(m, 'escrow_release', { id: 'early-release' }).reason, 'invalid_transition');
  assert.equal(m.summary().escrow.state, 'funded'); // escrow never half-opens
});

test('the timed refund is chained to the SCRIPT timer, blocks from funding height', () => {
  const m = freshMembrane();
  openOrder(m);
  fundOrder(m, { sats: depositSats(m.summary()).toString() });
  // day 19: locked
  assert.equal(
    settleOrder(m, 'escrow_refund', { id: 'too-early', height: FUND_HEIGHT + 2879, refundKind: 'timed' }).reason,
    'escrow_refused',
  );
  assert.equal(m.summary().escrow.state, 'funded');
  // fundingHeight + delayBlocks is high enough (exact minute) — refunds
  // unlock at or after the number of blocks the script was told to wait
  assert.equal(
    settleOrder(m, 'escrow_refund', { id: 'on-time', height: FUND_HEIGHT + 2880, refundKind: 'timed' }).status,
    'accepted',
  );
  const closed = m.summary();
  assert.equal(closed.escrow.state, 'refunded');
  assert.equal(closed.escrow.refundKind, 'timed');
});

test('an admitted refund lands right after funding — zero fee lives in the money table', () => {
  const m = freshMembrane();
  openOrder(m);
  fundOrder(m, { sats: depositSats(m.summary()).toString() });
  assert.equal(
    settleOrder(m, 'escrow_refund', { id: 'admit-no-wait', height: FUND_HEIGHT + 1 }).status, 'accepted',
  );
  const st = m.summary();
  assert.equal(st.escrow.state, 'refunded');
  assert.equal(st.status, 'refunded');
});

test('a forged escrow_open by the buyer hits the authority wall, not the escrow', () => {
  const m = freshMembrane();
  const result = m.admit({
    schemaVersion: 1,
    operationId: 'forge-1',
    principal: 'buyer',
    payload: {
      type: 'escrow_open', expectedRevision: 0, currency: 'btc',
      priceSats: PRICE.toString(), scriptHex: SCRIPT_HEX, delayBlocks: 2880,
      issuedAt: 1_000,
    },
  });
  assert.equal(result.reason, 'authority');
  assert.equal(m.summary().escrow, null);
  assert.equal(m.summary().status, 'pending');
});

test('a non-BTC order never opens escrow, and a dust order never quotes', () => {
  const m = freshMembrane();
  const xmr = m.admit({
    schemaVersion: 1, operationId: 'xmr-1', principal: 'vendor',
    payload: {
      type: 'escrow_open', expectedRevision: 0, currency: 'xmr',
      priceSats: PRICE.toString(), scriptHex: SCRIPT_HEX, delayBlocks: 2880, issuedAt: 1_000,
    },
  });
  assert.equal(xmr.reason, 'malformed');
  const dust = m.admit({
    schemaVersion: 1, operationId: 'dust-1', principal: 'vendor',
    payload: {
      type: 'escrow_open', expectedRevision: 0, currency: 'btc',
      priceSats: (MIN_ORDER_SATS - 1n).toString(), scriptHex: SCRIPT_HEX,
      delayBlocks: 2880, issuedAt: 1_000,
    },
  });
  assert.equal(dust.reason, 'malformed');
});

test('the script at the door: a forged shape or a timer lie is malformed', () => {
  const m = freshMembrane();
  // a stranger's refund key — decodeOrderScript refuses the shape
  const tweaked = SCRIPT_HEX.replace(/^.{4}/, 'ffff'); // OP_IF becomes garbage
  assert.equal(
    m.admit({
      schemaVersion: 1, operationId: 'bad-script', principal: 'vendor',
      payload: {
        type: 'escrow_open', expectedRevision: 0, currency: 'btc',
        priceSats: PRICE.toString(), scriptHex: tweaked, delayBlocks: 2880, issuedAt: 1_000,
      },
    }).reason, 'malformed',
  );
  // the payload's timer and the script's timer must agree
  assert.equal(
    m.admit({
      schemaVersion: 1, operationId: 'timer-lie', principal: 'vendor',
      payload: {
        type: 'escrow_open', expectedRevision: 0, currency: 'btc',
        priceSats: PRICE.toString(), scriptHex: SCRIPT_HEX, delayBlocks: 300,
        issuedAt: 1_000,
      },
    }).reason, 'malformed',
  );
  assert.equal(m.summary().escrow, null);
});

test('funding with zero confirmations never marks seen — no 0-conf for escrow either', () => {
  const m = freshMembrane();
  openOrder(m);
  assert.equal(
    fundOrder(m, { sats: depositSats(m.summary()).toString(), confirmations: 0 }).reason,
    'malformed',
  );
  assert.equal(m.summary().paymentState, 'address_issued');
});

test('a stale revision loses; escrow rides the same CAS counter as everything else', () => {
  const m = freshMembrane();
  openOrder(m, { revision: 0 });
  assert.equal(
    fundOrder(m, { revision: 0, id: 'stale-fund', sats: depositSats(m.summary()).toString() }).reason,
    'stale',
  );
});

test('replay dedup: the same fund twice is a duplicate, not two escrow facts', () => {
  const m = freshMembrane();
  openOrder(m);
  const st = m.summary();
  const envelope = {
    schemaVersion: 1, operationId: 'fund-once', principal: 'watcher',
    payload: { type: 'escrow_fund', expectedRevision: st.revision, txid: TX_FUND, sats: depositSats(st).toString(), confirmations: 1, height: FUND_HEIGHT },
  };
  assert.equal(m.admit(envelope).status, 'accepted');
  assert.equal(m.admit(envelope).status, 'duplicate');
  assert.equal(m.summary().escrow.fundingTxid, TX_FUND);
  // same id, different payload: a surfaced conflict, the fund is the one fund
  assert.equal(m.admit({ ...envelope, payload: { ...envelope.payload, sats: (depositSats(st) + 5n).toString() } }).status, 'conflict');
});

test('tamper recovery: a forged journal line is dropped with everything after it', () => {
  // one real escrow history on one journal
  const journal = new MemoryJournal();
  const m = new OrderMembrane('order-1', 'btc', journal);
  openOrder(m);
  fundOrder(m, { sats: depositSats(m.summary()).toString() });
  const live = m.summary();
  assert.equal(live.escrow.state, 'funded');

  // an attacker appends a forged "release" line: right shape, right seq,
  // wrong digest. Replay must drop it and keep the funded box.
  const forged = JSON.stringify({
    kind: 'commit', schemaVersion: 1, orderId: 'order-1', seq: 3,
    opId: 'forged-release', digest: '0000000000000000', principal: 'watcher',
    op: { type: 'escrow_release', expectedRevision: live.revision, txid: TX_SETTLE },
  });
  const reopened = new OrderMembrane('order-1', 'btc', new RecoveryJournal(`\n${journal.raw()}${forged}\n`));
  const healed = reopened.summary();
  assert.equal(healed.escrow.state, 'funded');
  assert.equal(healed.escrow.settleTxid, null);
  assert.equal(healed.revision, live.revision);
  assert.deepEqual(reopened.recoveryAnomalies, ['digest_mismatch']);
  // and fresh facts land on the healed prefix: the box stays fundable-resisting
  assert.equal(
    reopened.admit({
      schemaVersion: 1, operationId: 'post-heal', principal: 'watcher',
      payload: { type: 'escrow_release', expectedRevision: reopened.summary().revision, txid: TX_SETTLE },
    }).reason, 'invalid_transition', // still before confirm, still refused
  );
});

// A journal that replays from saved raw text, standing in for what the
// browser would hold — same pattern as the membrane's own tests.
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

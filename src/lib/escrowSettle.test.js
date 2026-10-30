// Item 1 of the market brief, attacked from the buyer's chair.
//
// Two facts have to survive this file:
//   1. A funded order releases only when BOTH keys sign, and the money table
//      is the FSM's to the satoshi. The fee has a destination or the release
//      is never built.
//   2. A refund pays the buyer's own refund key, and the buyer needs nobody
//      else to take it. No server, no peer, no relay, no vendor key.
//
// And one property that makes either worth anything: what the membrane
// admits is written to the device's own table before the caller acts on it,
// and reopening from that table arrives at the same order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bech32 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { assembleOrderScript, hexToScript, scriptToHex } from './escrowScript.js';
import { quoteEscrow } from './escrowFsm.js';
import { buildEscrowAcceptance, newEscrowSalt, orderEscrowKey } from './escrowActions.js';
import { satsToCoins } from './orderMembrane.js';
import {
  addressScriptHex,
  buildAdmittedRefundSpend,
  buildReleaseSpend,
  buildTimedRefundSpend,
  p2pkScriptHex,
  refundOutputs,
  scriptParties,
  settleEnvelope,
} from './escrowSettle.js';
import { admitAndFlush, openOrderMembrane } from './orderJournal.js';

// The device's own table, small enough to read. Writes can be made to fail so
// the "saved" answer can be attacked.
class FakeTable {
  rows = [];
  failNextPut = false;

  async put(row) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('disk full');
    }
    const at = this.rows.findIndex((r) => r.orderId === row.orderId && r.seq === row.seq);
    if (at >= 0) this.rows[at] = row;
    else this.rows.push(row);
  }

  async delete(key) {
    const [orderId, seq] = key;
    this.rows = this.rows.filter((r) => !(r.orderId === orderId && r.seq === seq));
  }

  where(field) {
    assert.equal(field, 'orderId');
    return {
      equals: (value) => ({
        sortBy: async (sortField) => this.rows
          .filter((r) => r.orderId === value)
          .sort((a, b) => a[sortField] - b[sortField]),
      }),
    };
  }
}

const PRICE = 50_000_000n; // 0.5 BTC
const DELAY_BLOCKS = 2880; // 20 days
const FUNDING_TXID = 'aa'.repeat(32);
const FUNDING_HEIGHT = 800_000;
const ORDER_ID = 'order-settle-1';
const ISSUED_AT = 1_700_000_000;

const buyerSecret = secp256k1.utils.randomSecretKey();
const vendorSecret = secp256k1.utils.randomSecretKey();
const marketSecret = secp256k1.utils.randomSecretKey();

const marketPubHex = scriptToHex(secp256k1.getPublicKey(marketSecret, true));

// The deal both sides assemble, through the app's own acceptance builder so
// the script and the quote come from one place.
async function deal({ priceSats = PRICE } = {}) {
  const salt = newEscrowSalt();
  const buyer = await orderEscrowKey(buyerSecret, salt);
  const vendor = await orderEscrowKey(vendorSecret, salt);
  const { escrow } = buildEscrowAcceptance({
    priceSats,
    delayBlocks: DELAY_BLOCKS,
    vendorPubHex: vendor.publicKeyHex,
    buyerPubHex: buyer.publicKeyHex,
    issuedAt: ISSUED_AT,
  });
  const script = assembleOrderScript({
    vendorPubKey: hexToScript(vendor.publicKeyHex),
    buyerPubKey: hexToScript(buyer.publicKeyHex),
    delayBlocks: DELAY_BLOCKS,
  });
  assert.equal(scriptToHex(script), escrow.scriptHex, 'the card and the script agree');
  return {
    escrow,
    buyerKey: buyer.privateKeyBytes,
    vendorKey: vendor.privateKeyBytes,
    buyerPubHex: buyer.publicKeyHex,
    vendorPubHex: vendor.publicKeyHex,
    scriptHex: scriptToHex(script),
    funding: { txid: FUNDING_TXID, vout: 0, sats: BigInt(escrow.depositSats), scriptHex: scriptToHex(script) },
  };
}

// The order as the membrane sees it: opened, funded, confirmed. Returns the
// open door and the funded card.
async function fundedOnRecord(table = new FakeTable(), fundingFacts = null) {
  const { membrane, journal } = await openOrderMembrane(ORDER_ID, 'btc', table);
  const opened = await admitAndFlush(membrane, journal, {
    schemaVersion: 1,
    operationId: 'open:1',
    principal: 'vendor',
    orderId: ORDER_ID,
    payload: {
      type: 'escrow_open',
      expectedRevision: 0,
      currency: 'btc',
      scriptHex: fundingFacts.scriptHex,
      priceSats: PRICE.toString(),
      delayBlocks: DELAY_BLOCKS,
      issuedAt: ISSUED_AT,
    },
  });
  assert.equal(opened.status, 'accepted');
  const funded = await admitAndFlush(membrane, journal, {
    schemaVersion: 1,
    operationId: `fund:${FUNDING_TXID}`,
    principal: 'watcher',
    orderId: ORDER_ID,
    payload: {
      type: 'escrow_fund',
      expectedRevision: 1,
      txid: FUNDING_TXID,
      sats: fundingFacts.sats.toString(),
      confirmations: 1,
      height: FUNDING_HEIGHT,
    },
  });
  assert.equal(funded.status, 'accepted');
  return { membrane, journal, table };
}

async function confirmed({ membrane, journal }) {
  const report = await admitAndFlush(membrane, journal, {
    schemaVersion: 1,
    operationId: `confirm:${FUNDING_TXID}`,
    principal: 'watcher',
    orderId: ORDER_ID,
    payload: {
      type: 'watcher_report',
      expectedRevision: membrane.summary().revision,
      report: { source: 'watcher', txid: FUNDING_TXID, confirmations: 3, amount: satsToCoins(BigInt(quoteEscrow(PRICE).depositSats)) },
    },
  });
  assert.equal(report.status, 'accepted');
}

test('a funded order releases only with both signatures, and pays the FSM table', async () => {
  const d = await deal();
  const spend = buildReleaseSpend({
    funding: d.funding,
    priceSats: PRICE,
    feeScriptHex: p2pkScriptHex(marketPubHex),
    vendorKeyBytes: d.vendorKey,
    buyerKeyBytes: d.buyerKey,
  });
  assert.deepEqual(spend.outputs.map((o) => o.sats), [48_750_000n, 2_500_000n]);
  assert.equal(spend.outputs[0].scriptHex, p2pkScriptHex(d.vendorPubHex));
  assert.equal(spend.outputs[1].scriptHex, p2pkScriptHex(marketPubHex));
  assert.deepEqual(spend.parties, {
    scriptHex: d.scriptHex,
    vendorPubHex: d.vendorPubHex,
    buyerPubHex: d.buyerPubHex,
    delayBlocks: DELAY_BLOCKS,
  });
  // it is a real transaction, and its id is derived from its own bytes
  assert.equal(spend.txid.length, 64);
  assert.equal(spend.tx.vin.length, 1);
});

test('an overpay rides back to the buyer as change, and never leaks to the fee', async () => {
  const d = await deal();
  const overpaid = { ...d.funding, sats: d.funding.sats + 7_777n };
  const spend = buildReleaseSpend({
    funding: overpaid,
    priceSats: PRICE,
    minerFeeSats: 1_000n,
    feeScriptHex: p2pkScriptHex(marketPubHex),
    vendorKeyBytes: d.vendorKey,
    buyerKeyBytes: d.buyerKey,
  });
  assert.equal(spend.outputs.length, 3);
  assert.equal(spend.outputs[2].scriptHex, p2pkScriptHex(d.buyerPubHex));
  assert.equal(spend.outputs[2].sats, 7_777n - 1_000n);
  const paid = spend.outputs.reduce((n, o) => n + o.sats, 0n) + 1_000n;
  assert.equal(paid, overpaid.sats, 'outputs plus miner fee are the whole deposit');
});

test('a release with no fee destination is never built, and an address becomes one', async () => {
  const d = await deal();
  assert.throws(
    () => buildReleaseSpend({ funding: d.funding, priceSats: PRICE, vendorKeyBytes: d.vendorKey, buyerKeyBytes: d.buyerKey }),
    /not a script|even-length hex/,
  );
  // an operator pastes an address: witness v0, and the script is exact
  const program = Uint8Array.from({ length: 20 }, (_, i) => i + 1);
  const address = bech32.encode('bc', [0, ...bech32.toWords(program)]);
  const scriptHex = addressScriptHex(address);
  assert.equal(scriptHex, `0014${scriptToHex(program)}`);
  // a 32-byte program is a witness-script hash, and keeps its own opcode
  const scriptProgram = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  assert.equal(
    addressScriptHex(bech32.encode('bc', [0, ...bech32.toWords(scriptProgram)])),
    `0020${scriptToHex(scriptProgram)}`,
  );
  assert.throws(() => addressScriptHex('bc1notanaddress'), /bech32/);
  assert.throws(() => addressScriptHex(address, { network: 'test' }), /not a test address/);
});

test('a stranger\'s key signs nothing: both builder and signature check refuse', async () => {
  const d = await deal();
  const stranger = secp256k1.utils.randomSecretKey();
  assert.throws(
    () => buildReleaseSpend({
      funding: d.funding,
      priceSats: PRICE,
      feeScriptHex: p2pkScriptHex(marketPubHex),
      vendorKeyBytes: stranger,
      buyerKeyBytes: d.buyerKey,
    }),
    /does not verify against the script/,
  );
});

test('the release is admitted once, settles the order, and survives a reopen', async () => {
  const d = await deal();
  const table = new FakeTable();
  const door = await fundedOnRecord(table, d.funding);
  await confirmed(door);

  const spend = buildReleaseSpend({
    funding: d.funding,
    priceSats: PRICE,
    feeScriptHex: p2pkScriptHex(marketPubHex),
    vendorKeyBytes: d.vendorKey,
    buyerKeyBytes: d.buyerKey,
  });
  const envelope = settleEnvelope({
    type: 'escrow_release',
    txid: spend.txid,
    orderId: ORDER_ID,
    expectedRevision: door.membrane.summary().revision,
  });
  const first = await admitAndFlush(door.membrane, door.journal, envelope);
  assert.equal(first.status, 'accepted');
  assert.equal(door.membrane.summary().escrow.state, 'released');
  assert.equal(door.membrane.summary().status, 'completed');
  assert.equal(door.membrane.summary().escrow.settleTxid, spend.txid);
  assert.ok(table.rows.length >= 1, 'the released fact is on disk');

  // the same chain fact seen twice is one effect
  const again = await admitAndFlush(door.membrane, door.journal, envelope);
  assert.equal(again.status, 'duplicate');

  // and a different settlement cannot follow a closed order
  const refund = settleEnvelope({
    type: 'escrow_refund',
    txid: 'bb'.repeat(32),
    kind: 'timed',
    height: FUNDING_HEIGHT + DELAY_BLOCKS,
    orderId: ORDER_ID,
    expectedRevision: door.membrane.summary().revision,
  });
  const late = await admitAndFlush(door.membrane, door.journal, refund);
  assert.equal(late.status, 'rejected');
  assert.equal(late.reason, 'invalid_transition');

  // reload: the same table rebuilds the same order
  const reopened = await openOrderMembrane(ORDER_ID, 'btc', table);
  assert.equal(reopened.membrane.summary().escrow.state, 'released');
  assert.equal(reopened.membrane.summary().escrow.settleTxid, spend.txid);
  assert.equal(reopened.membrane.summary().revision, door.membrane.summary().revision);
});

test('an operation id reused with a different fact is a conflict, never a swallow', async () => {
  const d = await deal();
  const door = await fundedOnRecord(new FakeTable(), d.funding);
  await confirmed(door);
  const envelope = settleEnvelope({
    type: 'escrow_release',
    txid: 'cc'.repeat(32),
    orderId: ORDER_ID,
    expectedRevision: door.membrane.summary().revision,
  });
  assert.equal((await admitAndFlush(door.membrane, door.journal, envelope)).status, 'accepted');
  const forged = { ...envelope, payload: { ...envelope.payload, txid: 'dd'.repeat(32) } };
  const verdict = await admitAndFlush(door.membrane, door.journal, forged);
  assert.equal(verdict.status, 'conflict');
  assert.equal(verdict.reason, 'op_id_reuse');
});

test('the buyer takes a refund alone: the script\'s own key, no vendor, no peer', async () => {
  const d = await deal();
  // Nothing here reads a vendor key, a server, or the network.
  const spend = buildTimedRefundSpend({
    funding: d.funding,
    priceSats: PRICE,
    minerFeeSats: 1_000n,
    buyerKeyBytes: d.buyerKey,
    blockNow: FUNDING_HEIGHT + DELAY_BLOCKS,
    fundingHeight: FUNDING_HEIGHT,
  });
  assert.equal(spend.outputs.length, 1);
  assert.equal(spend.outputs[0].scriptHex, p2pkScriptHex(d.buyerPubHex), 'it pays the script\'s own refund key');
  assert.equal(spend.outputs[0].sats, d.funding.sats - 1_000n, 'the whole deposit comes home');
  assert.equal(spend.tx.vin[0].sequence, DELAY_BLOCKS, 'the input sequence IS the CSV clock');
  assert.equal(spend.txid.length, 64);

  // Deterministic: the same buyer, the same box, the same transaction. A
  // rebuild after a reload is not a different spend.
  const rebuilt = buildTimedRefundSpend({
    funding: d.funding,
    priceSats: PRICE,
    minerFeeSats: 1_000n,
    buyerKeyBytes: d.buyerKey,
    blockNow: FUNDING_HEIGHT + DELAY_BLOCKS,
    fundingHeight: FUNDING_HEIGHT,
  });
  assert.equal(rebuilt.bytes, spend.bytes);
  assert.equal(rebuilt.txid, spend.txid);

  // one block early, the chain would refuse it: so does the builder
  assert.throws(
    () => buildTimedRefundSpend({
      funding: d.funding,
      priceSats: PRICE,
      buyerKeyBytes: d.buyerKey,
      blockNow: FUNDING_HEIGHT + DELAY_BLOCKS - 1,
      fundingHeight: FUNDING_HEIGHT,
    }),
    /refund timer has not run out/,
  );
});

test('a refund cannot be paid to anyone but the buyer, and a stranger\'s key cannot sign it', async () => {
  const d = await deal();
  // the money table is the buyer's, whatever the script says
  const outputs = refundOutputs({
    priceSats: PRICE,
    fundedSats: d.funding.sats,
    buyerPubHex: d.buyerPubHex,
  });
  assert.equal(outputs[0].scriptHex, p2pkScriptHex(d.buyerPubHex));
  // and a stranger holding the box cannot sign the refund
  const stranger = secp256k1.utils.randomSecretKey();
  assert.throws(
    () => buildTimedRefundSpend({ funding: d.funding, priceSats: PRICE, buyerKeyBytes: stranger }),
    /does not verify against the script/,
  );
});

test('the refund is admitted at its height, refused one block early, and survives a reopen', async () => {
  const d = await deal();
  const table = new FakeTable();
  const door = await fundedOnRecord(table, d.funding);
  const spend = buildTimedRefundSpend({ funding: d.funding, priceSats: PRICE, buyerKeyBytes: d.buyerKey });

  const early = await admitAndFlush(door.membrane, door.journal, settleEnvelope({
    type: 'escrow_refund',
    txid: spend.txid,
    kind: 'timed',
    height: FUNDING_HEIGHT + DELAY_BLOCKS - 1,
    orderId: ORDER_ID,
    expectedRevision: door.membrane.summary().revision,
  }));
  assert.equal(early.status, 'rejected');
  assert.equal(early.reason, 'escrow_refused');

  const onTime = await admitAndFlush(door.membrane, door.journal, settleEnvelope({
    type: 'escrow_refund',
    txid: spend.txid,
    kind: 'timed',
    height: FUNDING_HEIGHT + DELAY_BLOCKS,
    orderId: ORDER_ID,
    expectedRevision: door.membrane.summary().revision,
  }));
  assert.equal(onTime.status, 'accepted');
  assert.equal(door.membrane.summary().escrow.state, 'refunded');
  assert.equal(door.membrane.summary().escrow.refundKind, 'timed');
  assert.equal(door.membrane.summary().status, 'refunded');

  const reopened = await openOrderMembrane(ORDER_ID, 'btc', table);
  assert.equal(reopened.membrane.summary().escrow.state, 'refunded');
  assert.equal(reopened.membrane.summary().escrow.settleTxid, spend.txid);
});

test('an admitted refund is a release-shaped spend the vendor co-signs, and charges no fee', async () => {
  const d = await deal();
  const spend = buildAdmittedRefundSpend({
    funding: d.funding,
    priceSats: PRICE,
    minerFeeSats: 1_000n,
    vendorKeyBytes: d.vendorKey,
    buyerKeyBytes: d.buyerKey,
  });
  assert.equal(spend.outputs.length, 1);
  assert.equal(spend.outputs[0].scriptHex, p2pkScriptHex(d.buyerPubHex));
  assert.equal(spend.outputs[0].sats, d.funding.sats - 1_000n, 'no fee is taken on a refund');
});

test('a write that fails is a crash, never a saved fact', async () => {
  const d = await deal();
  const table = new FakeTable();
  const door = await fundedOnRecord(table, d.funding);
  await confirmed(door);
  const spend = buildReleaseSpend({
    funding: d.funding,
    priceSats: PRICE,
    feeScriptHex: p2pkScriptHex(marketPubHex),
    vendorKeyBytes: d.vendorKey,
    buyerKeyBytes: d.buyerKey,
  });
  const envelope = settleEnvelope({
    type: 'escrow_release',
    txid: spend.txid,
    orderId: ORDER_ID,
    expectedRevision: door.membrane.summary().revision,
  });
  table.failNextPut = true;
  const crashed = await admitAndFlush(door.membrane, door.journal, envelope);
  assert.equal(crashed.status, 'crashed');
  assert.equal(crashed.reason, 'journal_write_failed');
});

test('a torn tail on disk is dropped; the funded box still stands', async () => {
  const d = await deal();
  const table = new FakeTable();
  await fundedOnRecord(table, d.funding);
  // a half-written line lands after the good ones, the mid-write window
  table.rows.push({ orderId: ORDER_ID, seq: 99, line: '{"kind":"commit","seq":3' });
  const reopened = await openOrderMembrane(ORDER_ID, 'btc', table);
  assert.equal(reopened.membrane.summary().escrow.state, 'funded');
  assert.ok(reopened.membrane.recoveryAnomalies.includes('corrupt_line'));
  assert.equal(table.rows.some((r) => r.seq === 99), false, 'the bad tail left the table too');
  // and the door still works after the repair
  const spend = buildTimedRefundSpend({ funding: d.funding, priceSats: PRICE, buyerKeyBytes: d.buyerKey });
  const verdict = await admitAndFlush(reopened.membrane, reopened.journal, settleEnvelope({
    type: 'escrow_refund',
    txid: spend.txid,
    kind: 'timed',
    height: FUNDING_HEIGHT + DELAY_BLOCKS,
    orderId: ORDER_ID,
    expectedRevision: reopened.membrane.summary().revision,
  }));
  assert.equal(verdict.status, 'accepted');
  assert.equal(reopened.membrane.summary().escrow.state, 'refunded');
});

test('the script is the only source of parties and clock', async () => {
  const d = await deal();
  const parties = scriptParties(d.scriptHex);
  assert.equal(parties.vendorPubHex, d.vendorPubHex);
  assert.equal(parties.buyerPubHex, d.buyerPubHex);
  assert.equal(parties.delayBlocks, DELAY_BLOCKS);
  // anything that is not the exact shape names no parties at all
  assert.throws(() => scriptParties('00'), /exact two-branch escrow shape/);
  assert.throws(() => scriptParties('zz'), /even-length hex/);
});

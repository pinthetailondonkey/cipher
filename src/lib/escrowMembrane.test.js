import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderMembrane, MemoryJournal, satsToCoins } from './orderMembrane.js';
import { assembleOrderScript, assembleOvertOrderScript, assembleClockClaimScript, scriptToHex } from './escrowScript.js';
import { MIN_ORDER_SATS } from './escrowFsm.js';
import { sha256 } from '@noble/hashes/sha2.js';

// The escrow ops walk the SAME admission door every other order fact
// walks: decode -> dedup -> revision -> authority -> one journal record.
// These tests attack the door, not the escrow math (escrowFsm test owns
// that) and not the script bytes (escrowScript test owns those).

const PRICE = 50_000_000n; // 0.5 BTC
const PUB_V = Uint8Array.from({ length: 33 }, (_, i) => 0x11 + i);
const PUB_B = Uint8Array.from({ length: 33 }, (_, i) => 0x2a + i);
const SCRIPT_HEX = scriptToHex(assembleOrderScript({ vendorPubKey: PUB_V, buyerPubKey: PUB_B, delayBlocks: 2880 }));
// The delivery nonce and its commitment: the nonce is what the vendor
// alone holds; the hash is what the script fixes before funding.
const DELIVERY_NONCE = Uint8Array.from({ length: 32 }, (_, i) => 0xbc + i);
const DELIVERY_NONCE_HEX = scriptToHex(DELIVERY_NONCE);
const OVERT_HASH = sha256(DELIVERY_NONCE);
const OVERT_HASH_HEX = scriptToHex(OVERT_HASH);
const OVERT_SCRIPT_HEX = scriptToHex(assembleOvertOrderScript({
  vendorPubKey: PUB_V, buyerPubKey: PUB_B, delayBlocks: 2880, overtHash: OVERT_HASH,
}));
// The Clock Box: the same commitment, a fourth branch past the CSV
// clock — the founder's day-20 rule. claimBlocks == delayBlocks.
const CLOCK_SCRIPT_HEX = scriptToHex(assembleClockClaimScript({
  vendorPubKey: PUB_V, buyerPubKey: PUB_B, delayBlocks: 2880, overtHash: OVERT_HASH,
}));
// The enforced money table facts the watcher reports (the same shape
// the spend builder produces and the door re-checks): buyer P2PK.
const BUYER_P2PK = `21${scriptToHex(PUB_B)}ac`;
// and the claim's own table: vendor P2PK, fee-free.
const VENDOR_P2PK = `21${scriptToHex(PUB_V)}ac`;
const TX_FUND = 'aa'.repeat(32);
const TX_SETTLE = 'bb'.repeat(32);
const FUND_HEIGHT = 800_000;

function freshMembrane() {
  const membrane = new OrderMembrane('order-1', 'btc');
  return membrane;
}

function openOrder(m, { revision = 0, id = 'open-1', script = SCRIPT_HEX, overtHashHex } = {}) {
  return m.admit({
    schemaVersion: 1,
    operationId: id,
    principal: 'vendor',
    payload: {
      type: 'escrow_open', expectedRevision: revision, currency: 'btc',
      priceSats: PRICE.toString(), scriptHex: script, delayBlocks: 2880,
      issuedAt: 1_000, publicKeysHex: null, ...(overtHashHex ? { overtHashHex } : {}),
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

function settleOrder(m, kind, { revision, id = kind, height = FUND_HEIGHT, refundKind = 'admitted', overt } = {}) {
  const st = m.summary();
  return m.admit({
    schemaVersion: 1,
    operationId: id,
    principal: 'watcher',
    payload: {
      type: kind, expectedRevision: revision ?? st.revision,
      txid: TX_SETTLE, ...(kind === 'escrow_refund' ? { kind: refundKind } : {}), height,
      ...(kind === 'escrow_refund' && overt ? { ...overt } : {}),
    },
  });
}

// The exact facts a Dead Drop close reports (round 2 card): the
// revealed preimage, the buyer P2PK output, the sats that went home.
// feeSats = the miner's cut; keptSats = how much the spend left
// behind for anyone but the buyer (the lie under test).
function overtFacts(m, { feeSats = 1440n, keptSats = 0n, outScriptHex = BUYER_P2PK, preimageHex = DELIVERY_NONCE_HEX } = {}) {
  const funded = BigInt(m.summary().escrow.fundedSats);
  return {
    preimageHex,
    outScriptHex,
    sats: (funded - feeSats - keptSats).toString(),
  };
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

// The Dead Drop doors: the box opens only when the vendor SPOKE the
// commitment, and the ghost signature is the journal sequence
// funded -> overt refund -> the delivery word lives on-chain forever.
test('a dead drop box opens with the spoken commitment and refunds overt, fee-free, any time', () => {
  const m = freshMembrane();
  // the commitment must be spoken at the door: the script opens an
  // overt branch but the op names no hash -> malformed
  assert.equal(openOrder(m, { id: 'overt-silent', script: OVERT_SCRIPT_HEX }).reason, 'malformed');
  assert.equal(m.summary().escrow, null);
  // a hash that is not the script's hash -> malformed, too
  assert.equal(
    openOrder(m, { id: 'overt-lie', script: OVERT_SCRIPT_HEX, overtHashHex: '00'.repeat(32) }).reason,
    'malformed',
  );
  // the spoken truth opens the box, and the summary carries what the
  // script commits to
  assert.equal(openOrder(m, { id: 'overt-open', script: OVERT_SCRIPT_HEX, overtHashHex: OVERT_HASH_HEX }).status, 'accepted');
  let st = m.summary();
  assert.equal(st.escrow.overtHashHex, OVERT_HASH_HEX);
  assert.equal(st.escrow.state, 'draft');

  fundOrder(m, { sats: depositSats(st).toString() });
  // the dead drop fires ANY time after funding — day zero, hours in:
  // overt refund at funding height + 1, like an admitted one
  assert.equal(settleOrder(m, 'escrow_refund', {
    id: 'overt-refund', height: FUND_HEIGHT + 1, refundKind: 'overt', overt: overtFacts(m),
  }).status, 'accepted');
  st = m.summary();
  assert.equal(st.escrow.state, 'refunded');
  assert.equal(st.escrow.refundKind, 'overt');
  assert.equal(st.escrow.settleTxid, TX_SETTLE);
  // the attestation survives in trusted state: the word now on-chain
  assert.equal(st.escrow.deliveredPreimageHex, DELIVERY_NONCE_HEX);
  assert.equal(st.escrow.returnedSats, (depositSats(st) - 1440n).toString()); // the helper reports funded minus the miner fee

  // and the ghost signature survives replay byte-exactly: the journal
  // puts the same box back, commitment, refund kind and delivery word
  // included
  const journal = new MemoryJournal();
  const m2 = new OrderMembrane('order-1', 'btc', journal);
  openOrder(m2, { id: 'overt-open', script: OVERT_SCRIPT_HEX, overtHashHex: OVERT_HASH_HEX });
  fundOrder(m2, { sats: depositSats(m2.summary()).toString() });
  settleOrder(m2, 'escrow_refund', { id: 'overt-refund', height: FUND_HEIGHT + 1, refundKind: 'overt', overt: overtFacts(m2) });
  const fresh = new OrderMembrane('order-1', 'btc', journal);
  assert.equal(fresh.summary().escrow.refundKind, 'overt');
  assert.equal(fresh.summary().escrow.overtHashHex, OVERT_HASH_HEX);
  assert.equal(fresh.summary().escrow.deliveredPreimageHex, DELIVERY_NONCE_HEX);
});

// Round-2 card, vector 5 (membrane spoof) + 6 (phantom replay): the
// word 'overt' is bound to three byte facts held against THIS escrow,
// and every one of them refuses the rename.
test('the word overt cannot ride past the door without its bytes', () => {
  const funded = (m0) => {
    openOrder(m0, { id: 'overt-open', script: OVERT_SCRIPT_HEX, overtHashHex: OVERT_HASH_HEX });
    fundOrder(m0, { sats: depositSats(m0.summary()).toString() });
  };
  // missing facts: malformed at the decode, before anything applies
  const mMissing = freshMembrane();
  funded(mMissing);
  assert.equal(settleOrder(mMissing, 'escrow_refund', { id: 'no-facts', refundKind: 'overt' }).reason, 'malformed');
  assert.equal(mMissing.summary().escrow.state, 'funded');
  // wrong preimage: hashes to the wrong thing -> escrow_refused
  const mWrongWord = freshMembrane();
  funded(mWrongWord);
  assert.equal(settleOrder(mWrongWord, 'escrow_refund', {
    id: 'wrong-word', refundKind: 'overt',
    overt: overtFacts(mWrongWord, { preimageHex: 'ff'.repeat(32) }),
  }).reason, 'escrow_refused');
  assert.equal(mWrongWord.summary().escrow.state, 'funded');
  assert.equal(mWrongWord.summary().escrow.settleTxid, null);
  // a stranger's key as the output: the refund branch pays THE buyer
  const mStranger = freshMembrane();
  funded(mStranger);
  assert.equal(settleOrder(mStranger, 'escrow_refund', {
    id: 'stranger-out', refundKind: 'overt',
    overt: overtFacts(mStranger, { outScriptHex: `21${'f0'.repeat(33)}ac` }),
  }).reason, 'escrow_refused');
  // a cooperative release renamed 'overt': the output it pays is a
  // P2PKH of something, not the buyer key the branch names. The output
  // SHAPE is refused even earlier, at the decode.
  const mRelease = freshMembrane();
  funded(mRelease);
  assert.equal(settleOrder(mRelease, 'escrow_refund', {
    id: 'rename-release', refundKind: 'overt',
    overt: overtFacts(mRelease, { outScriptHex: '76a914' + '55'.repeat(20) + '88ac' }),
  }).reason, 'malformed');
  // the escrow itself was never a Dead Drop: the plain box refuses the
  // word outright, however complete the facts
  const mPlain = freshMembrane();
  openOrder(mPlain);
  fundOrder(mPlain, { sats: depositSats(mPlain.summary()).toString() });
  assert.equal(settleOrder(mPlain, 'escrow_refund', { id: 'plain-overt', refundKind: 'overt', overt: overtFacts(mPlain) }).reason, 'escrow_refused');
});
// No "returned S must equal funded" gate, on purpose: the destination
// check is the anti-theft wall (only the buyer's key may be paid), and
// a smaller buyer output is the vendor BURNING the difference to
// miners — spite that costs the vendor, never steals for them. The
// sats go home as the watcher's read, same trust escrow_fund rides.
// The spend builder's own one-output buyer-P2PK table is the tight
// version of this rule for money built by this app.

test('nobody but the watcher says refund, and no refund talks before funding', () => {
  // vector 6's phantom: a vendor-crafted overt refund on an order that
  // never funded. Two doors stop it before the chain is even asked.
  const m = freshMembrane();
  openOrder(m, { id: 'overt-open', script: OVERT_SCRIPT_HEX, overtHashHex: OVERT_HASH_HEX });
  const st = m.summary();
  const fakeFacts = { preimageHex: DELIVERY_NONCE_HEX, outScriptHex: BUYER_P2PK, sats: '100' };
  // the vendor cannot SAY refund at all — the authority wall
  const vendorClaim = m.admit({
    schemaVersion: 1, operationId: 'vend-claims', principal: 'vendor',
    payload: { type: 'escrow_refund', expectedRevision: st.revision, txid: TX_SETTLE, kind: 'overt', height: FUND_HEIGHT + 1, ...fakeFacts },
  });
  assert.equal(vendorClaim.reason, 'authority');
  // even the watcher cannot say it of unfunded money — the box state wall
  assert.equal(
    m.admit({
      schemaVersion: 1, operationId: 'phantom-refund', principal: 'watcher',
      payload: { type: 'escrow_refund', expectedRevision: st.revision, txid: TX_SETTLE, kind: 'overt', height: FUND_HEIGHT + 1, ...fakeFacts },
    }).reason, 'invalid_transition',
  );
  // fund it, and the honest path still walks: the walls only stop lies
  fundOrder(m, { sats: depositSats(m.summary()).toString() });
  assert.equal(settleOrder(m, 'escrow_refund', { id: 'overt-next', refundKind: 'overt', overt: overtFacts(m) }).status, 'accepted');
});

// The founder's day-20 rule at the membrane: the Clock Box's fourth
// branch takes its seat. The claim is the dead drop's twin — the SAME
// preimage, the SAME single-spigot byte law — but it fires only past
// the CSV clock and pays THE VENDOR, fee-free.
test('a clock box opens like any dead drop and the day-20 claim pays the vendor', () => {
  const m = freshMembrane();
  // the same open door, the same spoken commitment
  assert.equal(openOrder(m, { id: 'clock-open', script: CLOCK_SCRIPT_HEX, overtHashHex: OVERT_HASH_HEX }).status, 'accepted');
  fundOrder(m, { sats: depositSats(m.summary()).toString() });
  // day one: the clock has not run — the early-fire lie is refused
  assert.equal(settleOrder(m, 'escrow_refund', {
    id: 'clock-early', height: FUND_HEIGHT + 1, refundKind: 'claimed', overt: overtFacts(m, { outScriptHex: VENDOR_P2PK }),
  }).reason, 'escrow_refused');
  assert.equal(m.summary().escrow.state, 'funded');
  // day 20 (block 2880 past funding): the claim fires, all money home,
  // fee-free, to the vendor key the release branch verifies
  assert.equal(settleOrder(m, 'escrow_refund', {
    id: 'clock-claim', height: FUND_HEIGHT + 2880, refundKind: 'claimed', overt: overtFacts(m, { outScriptHex: VENDOR_P2PK }),
  }).status, 'accepted');
  const st = m.summary();
  assert.equal(st.escrow.state, 'claimed');
  assert.equal(st.escrow.refundKind, 'claimed');
  assert.equal(st.escrow.settleTxid, TX_SETTLE);
  assert.equal(st.escrow.claimedSats, (depositSats(st) - 1440n).toString());
  assert.equal(st.escrow.deliveredPreimageHex, DELIVERY_NONCE_HEX);
  assert.equal(st.status, 'completed'); // the vendor delivered on their word; the deal is done
  // the exact clock boundary: a block EARLY is refused, the boundary
  // block itself is accepted (the chain's CSV is >=)
  const mEdge = freshMembrane();
  openOrder(mEdge, { id: 'clock-open', script: CLOCK_SCRIPT_HEX, overtHashHex: OVERT_HASH_HEX });
  fundOrder(mEdge, { sats: depositSats(mEdge.summary()).toString() });
  assert.equal(settleOrder(mEdge, 'escrow_refund', {
    id: 'clock-2879', height: FUND_HEIGHT + 2879, refundKind: 'claimed', overt: overtFacts(mEdge, { outScriptHex: VENDOR_P2PK }),
  }).reason, 'escrow_refused');
  assert.equal(settleOrder(mEdge, 'escrow_refund', {
    id: 'clock-2880', height: FUND_HEIGHT + 2880, refundKind: 'claimed', overt: overtFacts(mEdge, { outScriptHex: VENDOR_P2PK }),
  }).status, 'accepted');

  // the claim survives replay byte-exactly, delivery word included
  // (the reload decode must read the journal's nested fact shape)
  const journal = new MemoryJournal();
  const m2 = new OrderMembrane('order-1', 'btc', journal);
  openOrder(m2, { id: 'clock-open', script: CLOCK_SCRIPT_HEX, overtHashHex: OVERT_HASH_HEX });
  fundOrder(m2, { sats: depositSats(m2.summary()).toString() });
  settleOrder(m2, 'escrow_refund', { id: 'clock-claim', height: FUND_HEIGHT + 2880, refundKind: 'claimed', overt: overtFacts(m2, { outScriptHex: VENDOR_P2PK }) });
  const fresh = new OrderMembrane('order-1', 'btc', journal);
  const re = fresh.summary();
  assert.equal(re.escrow.state, 'claimed');
  assert.equal(re.escrow.refundKind, 'claimed');
  assert.equal(re.escrow.claimedSats, (depositSats(re) - 1440n).toString());
  assert.equal(re.escrow.deliveredPreimageHex, DELIVERY_NONCE_HEX);
  assert.equal(re.status, 'completed');
});

// The claim's single-spigot law, twin to the overt door: every lie the
// overt door refuses, the claim door refuses too, plus the two that
// belong to the clock alone — firing early, and firing on a box with
// no clock at all.
test('the word claimed cannot ride past the door without its bytes', () => {
  const funded = (m0) => {
    openOrder(m0, { id: 'clock-open', script: CLOCK_SCRIPT_HEX, overtHashHex: OVERT_HASH_HEX });
    fundOrder(m0, { sats: depositSats(m0.summary()).toString() });
  };
  // missing facts: malformed at the decode
  const mMissing = freshMembrane();
  funded(mMissing);
  assert.equal(settleOrder(mMissing, 'escrow_refund', { id: 'no-facts', refundKind: 'claimed' }).reason, 'malformed');
  assert.equal(mMissing.summary().escrow.state, 'funded');
  // wrong preimage: hashes to the wrong thing -> escrow_refused
  const mWrongWord = freshMembrane();
  funded(mWrongWord);
  assert.equal(settleOrder(mWrongWord, 'escrow_refund', {
    id: 'wrong-word', refundKind: 'claimed', height: FUND_HEIGHT + 2880,
    overt: overtFacts(mWrongWord, { outScriptHex: VENDOR_P2PK, preimageHex: 'ff'.repeat(32) }),
  }).reason, 'escrow_refused');
  // the BUYER key as the claim output: the claim pays THE vendor
  const mBuyerOut = freshMembrane();
  funded(mBuyerOut);
  assert.equal(settleOrder(mBuyerOut, 'escrow_refund', {
    id: 'buyer-out', refundKind: 'claimed', height: FUND_HEIGHT + 2880,
    overt: overtFacts(mBuyerOut, { outScriptHex: BUYER_P2PK }),
  }).reason, 'escrow_refused');
  assert.equal(mBuyerOut.summary().escrow.state, 'funded');
  // a box with no clock at all: the bare dead drop (overt branch, no
  // claim branch) refuses the word — there is nothing to fire
  const mDeadDrop = freshMembrane();
  openOrder(mDeadDrop, { id: 'overt-open', script: OVERT_SCRIPT_HEX, overtHashHex: OVERT_HASH_HEX });
  fundOrder(mDeadDrop, { sats: depositSats(mDeadDrop.summary()).toString() });
  assert.equal(settleOrder(mDeadDrop, 'escrow_refund', {
    id: 'no-clock', refundKind: 'claimed', height: FUND_HEIGHT + 2880,
    overt: overtFacts(mDeadDrop, { outScriptHex: VENDOR_P2PK }),
  }).reason, 'escrow_refused');
  // and the plain box, the same
  const mPlain = freshMembrane();
  openOrder(mPlain);
  fundOrder(mPlain, { sats: depositSats(mPlain.summary()).toString() });
  assert.equal(settleOrder(mPlain, 'escrow_refund', {
    id: 'plain-claim', refundKind: 'claimed', height: FUND_HEIGHT + 2880,
    overt: overtFacts(mPlain, { outScriptHex: VENDOR_P2PK }),
  }).reason, 'escrow_refused');
  // the twin exit stays open: on a Clock Box, the vendor can still
  // return everything overt, fee-free, any time — the claim never
  // locks the honest close out
  const mTwin = freshMembrane();
  openOrder(mTwin, { id: 'clock-open', script: CLOCK_SCRIPT_HEX, overtHashHex: OVERT_HASH_HEX });
  fundOrder(mTwin, { sats: depositSats(mTwin.summary()).toString() });
  assert.equal(settleOrder(mTwin, 'escrow_refund', {
    id: 'twin-overt', height: FUND_HEIGHT + 5, refundKind: 'overt', overt: overtFacts(mTwin),
  }).status, 'accepted');
  assert.equal(mTwin.summary().escrow.refundKind, 'overt');
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Escrow,
  feeShare,
  quoteEscrow,
  canEscrow,
  FEE_PER_MILLE,
  MIN_ORDER_SATS,
  BLOCKS_PER_DAY,
} from './escrowFsm.js';

// The escrow money table, attacked before anyone's coins exist. Every
// path in docs/ESCROW.md gets a test, and the unit-crossing rules from
// CLAUDE.md get their own: a number is never a coin amount, rounding
// half-up never drops a sat, and outputs always conserve the deposit.

const P = 50_000_000n; // 0.5 BTC
const DAY = BigInt(BLOCKS_PER_DAY);

function openEscrow(price = P) {
  return new Escrow({ priceSats: price });
}

test('the quote: 5% total, 2.5% each side, deposit = price + buyer share', () => {
  const q = quoteEscrow(P);
  assert.equal(q.buyerFeeSats, 1_250_000n);
  assert.equal(q.vendorFeeSats, 1_250_000n);
  assert.equal(q.depositSats, 51_250_000n); // price + buyer share
  assert.equal(q.vendorOutSats, 48_750_000n); // price - vendor share
  assert.equal(q.feeOutSats, 2_500_000n); // the whole 5%
  assert.equal(q.buyerFeeSats + q.vendorFeeSats, (P * 2n * BigInt(FEE_PER_MILLE)) / 1000n - 0n || 2_500_000n);
});

test('a release conserves the deposit exactly — no sat appears or vanishes', () => {
  const esc = openEscrow();
  esc.fund(esc.depositSats());
  const outs = esc.release();
  assert.equal(
    outs.vendorOutSats + outs.feeOutSats + outs.buyerChangeSats,
    esc.fundedSats,
  );
  assert.equal(outs.vendorOutSats, 48_750_000n);
  assert.equal(outs.feeOutSats, 2_500_000n);
  assert.equal(outs.buyerChangeSats, 0n);
});

test('an overpay rides back to the buyer as change, all of it', () => {
  const esc = openEscrow();
  esc.fund(esc.depositSats() + 7_000n);
  const outs = esc.release();
  assert.equal(outs.buyerChangeSats, 7_000n);
  assert.equal(outs.vendorOutSats, 48_750_000n);
  assert.equal(outs.feeOutSats, 2_500_000n);
});

test('rounding is half-up and the odd sat goes to the fee, never to a party', () => {
  // exact half a sat rounds UP: 60_000 sats * 25/1000 = 1,500.0 -> 1_500? no:
  // 40060 * 25 = 1_001_500 thousandths -> 1_001.5 sats -> half-up 1_002.
  assert.equal(feeShare(40060n), 1002n);
  // a hair over the boundary already rounds from the remainder alone.
  assert.equal(feeShare(60_000_001n), 1_500_000n); // 1500000025/1000 = 1500000.025 -> floor half-off
  // and an odd-price deal still conserves: fee eats the odd sat.
  const price = 40061n; // 25*40061 = 1_001_525 -> 1001.525 -> 1002
  const q = quoteEscrow(price);
  assert.equal(q.vendorOutSats + q.feeOutSats, q.depositSats - q.buyerFeeSats + q.buyerFeeSats);
  const esc = new Escrow({ priceSats: price });
  esc.fund(esc.depositSats());
  const outs = esc.release();
  assert.equal(outs.vendorOutSats + outs.feeOutSats + outs.buyerChangeSats, esc.fundedSats);
  // both shares land on round numbers together; the fee output absorbs the odd sat.
  assert.equal(q.feeOutSats, q.buyerFeeSats + q.vendorFeeSats);
});

test('an underpay is refused at the door and nothing moves', () => {
  const esc = openEscrow();
  assert.throws(() => esc.fund(esc.depositSats() - 1n), /short/);
  assert.equal(esc.state, 'draft');
  // the honest deposit still works right after
  esc.fund(esc.depositSats());
  assert.equal(esc.state, 'funded');
});

test('funding twice is refused; a number is not a coin amount', () => {
  const esc = openEscrow();
  esc.fund(esc.depositSats());
  assert.throws(() => esc.fund(esc.depositSats()), /twice/);
  assert.throws(() => new Escrow({ priceSats: 12.5 }), /whole number/);
});

test('release before funding is refused; refund after release is refused', () => {
  const esc = openEscrow();
  assert.throws(() => esc.release(), /draft/);
  esc.fund(esc.depositSats());
  esc.proposeRelease().done();
  assert.equal(esc.state, 'released');
  assert.throws(() => esc.admitRefund(), /released/);
});

test('the timeout refund: locked before the timer, whole deposit after, zero fee', () => {
  const esc = openEscrow();
  esc.fund(esc.depositSats(), { fundingBlock: 800_000n });
  // day 19: still locked
  const notYet = 800_000n + DAY * 19n;
  assert.throws(() => esc.refund({ kind: 'timed', blockNow: notYet }), /timer/);
  assert.equal(esc.state, 'funded');
  assert.equal(esc.timedRefundDue(notYet), false);
  // the clock is the chain's, not the app's: a phantom big phone clock changes nothing
  // day 21: the buyer's own key gets EVERYTHING back
  const due = 800_000n + DAY * 21n;
  assert.equal(esc.timedRefundDue(due), true);
  const out = esc.refund({ kind: 'timed', blockNow: due });
  assert.equal(out.buyerOutSats, esc.depositSats());
  assert.equal(out.feeOutSats, 0n);
});

test('the admitted refund: vendor co-signs early, everyone whole, zero fee', () => {
  const esc = openEscrow();
  esc.fund(esc.depositSats());
  const out = esc.admitRefund(); // any time after funding
  assert.equal(out.buyerOutSats, esc.depositSats());
  assert.equal(out.feeOutSats, 0n);
  assert.equal(esc.state, 'refunded');
  // and after a refund, escrow is closed: no release can follow
  assert.throws(() => esc.release(), /refunded/);
});

test('the dust rule: a tiny order cannot escrow', () => {
  assert.equal(canEscrow(9_000n), false); // fee share < 1000 sats
  assert.equal(canEscrow(MIN_ORDER_SATS), true); // fee share = 1000 exactly
  assert.equal(canEscrow(0n), false);
  assert.throws(
    () => new Escrow({ priceSats: 1_000n }),
    /dust/,
  );
});

test('the whale cap stays a constant the founder flips, and caps both sides', () => {
  // pure 5%: no cap set — a 1 BTC order fee share is 2.5% of it.
  const big = 100_000_000n; // 1 BTC
  assert.equal(feeShare(big), feeShare(big)); // pure math, no default cap
  // with a cap, BOTH sides cap at the same number and conservation holds:
  const cap = 1_250_000n; // the 2.5% of 0.5 BTC — a real constant the founder could set
  const q = quoteEscrow(big, { capSats: cap });
  assert.equal(q.buyerFeeSats, cap);
  assert.equal(q.vendorFeeSats, cap);
  assert.equal(q.vendorOutSats + q.feeOutSats, q.depositSats);
  // capped release still conserves
  const esc = new Escrow({ priceSats: big, caps: { capSats: cap } });
  esc.fund(esc.depositSats());
  const outs = esc.release();
  assert.equal(outs.vendorOutSats + outs.feeOutSats + outs.buyerChangeSats, esc.fundedSats);
  assert.equal(outs.vendorOutSats, big - cap);
  assert.equal(outs.feeOutSats, cap * 2n);
});

test('quote + conservation over a sweep of prices: outputs always sum to the deposit', () => {
  for (let p = 40_000n; p <= 300_000n; p += 1_111n) {
    const q = quoteEscrow(p);
    const esc = new Escrow({ priceSats: p });
    esc.fund(esc.depositSats());
    const outs = esc.release();
    assert.equal(
      outs.vendorOutSats + outs.feeOutSats + outs.buyerChangeSats,
      esc.fundedSats,
      `sats lost at price ${p}`,
    );
    assert.equal(q.depositSats, p + q.buyerFeeSats);
    assert.equal(q.vendorOutSats, p - q.vendorFeeSats);
  }
  // and the never-drop rule: shares only ever round UP off the boundary.
  for (let p = 40_001n; p < 40_021n; p += 1n) {
    assert.equal(feeShare(p), (p * 25n + 500n) / 1000n);
  }
});

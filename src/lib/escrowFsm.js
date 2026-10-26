// Escrow finite state machine — the money table from docs/ESCROW.md,
// expressed as code. Pure: sats in, sats out, no I/O, no clock, no
// network. The PSBT plumbing, the script assembly and the order-card UI
// all call this; none of them invent money math of their own.
//
// Every amount is a BigInt of satoshis. A number is never a coin amount.
// Rounding is half-up and never drops: an odd sat goes to the fee
// output, never to a party silently.

// 5% total, split evenly: 2.5% buyer / 2.5% vendor. In thousandths.
export const FEE_PER_MILLE = 25; // per side

// Dust rule (docs/ESCROW.md): a fee share must clear Bitcoin's dust
// floor, which puts the minimum escrow order at 40,000 sats. Shown on
// the card BEFORE escrow is offered, never after money moves.
export const DUST_FLOOR_SATS = 1000n;
export const MIN_ORDER_SATS = 40000n;

// The founder's whale-order cap, deliberately NOT hardcoded to a number
// (docs/ESCROW.md): null keeps pure 5%; a founder-set cap (per fee
// share, in sats) keeps big deals inside escrow. One constant, one flip.
export const REFERRAL_FEE_CAP_SATS = null;

const DEFAULT_DELAY_DAYS = 20;

// Half-up rounding on a per-mille share. feeShare(60001n) is
// 1,500,000.025 sats -> 1,500,000; feeShare(60000001n) -> 1500001? No:
// 60000001 * 25 = 1500000025 thousandths of a sat; +500 and floor.
// This function is the ONLY place escrow fees are computed.
export function feeShare(priceSats, { capSats = REFERRAL_FEE_CAP_SATS } = {}) {
  if (typeof priceSats !== 'bigint' || priceSats <= 0n) {
    throw new Error('The order price must be a positive whole number of satoshis.');
  }
  const share = (priceSats * BigInt(FEE_PER_MILLE) + 500n) / 1000n;
  if (capSats != null && share > capSats) return capSats;
  return share;
}

export function quoteEscrow(priceSats, caps = {}) {
  const buyerFee = feeShare(priceSats, caps);
  const vendorFee = feeShare(priceSats, caps);
  return {
    priceSats,
    buyerFeeSats: buyerFee,
    vendorFeeSats: vendorFee,
    depositSats: priceSats + buyerFee,
    vendorOutSats: priceSats - vendorFee,
    feeOutSats: buyerFee + vendorFee,
  };
}

export function canEscrow(priceSats) {
  if (typeof priceSats !== 'bigint' || priceSats <= 0n) return false;
  if (priceSats < MIN_ORDER_SATS) return false;
  return feeShare(priceSats) >= DUST_FLOOR_SATS;
}

// States and the one-line-per-state meaning the UI reads.
//   draft    : the quote exists; no money moved. Anyone can still walk away.
//   funded   : the deposit confirmed on chain. Money belongs to nobody.
//   released : both keys signed; vendor paid, fee paid. Done and happy.
//   refunded : money went home (vendor admitted, or the timer ran out).
export const ESCROW_STATES = Object.freeze(['draft', 'funded', 'released', 'refunded']);
export const REFUND_KINDS = Object.freeze(['admitted', 'timed']);

// Blocks per DAY at 10-minute blocks; the timer is the chain's, not the
// app's clock, so nothing here is forgeable by a lying phone.
export const BLOCKS_PER_DAY = 144;

export class Escrow {
  constructor({ priceSats, delayDays = DEFAULT_DELAY_DAYS, caps = {} } = {}) {
    if (typeof priceSats !== 'bigint' || priceSats <= 0n) {
      throw new Error('The order price must be a positive whole number of satoshis.');
    }
    if (!canEscrow(priceSats)) {
      throw new Error(`Escrow orders must price at ${MIN_ORDER_SATS}+ sats so the fee is not dust.`);
    }
    const q = quoteEscrow(priceSats, caps);
    this.priceSats = q.priceSats;
    this.buyerFeeSats = q.buyerFeeSats;
    this.vendorFeeSats = q.vendorFeeSats;
    this.delayDays = delayDays > 0 ? delayDays : DEFAULT_DELAY_DAYS;
    this.state = 'draft';
    this.fundedSats = null; // what ACTUALLY landed — overpay belongs to the buyer
    this.fundingBlock = null;
  }

  #assertState(expected, action) {
    if (this.state !== expected) {
      throw new Error(`A deal that is ${this.state} cannot ${action}.`);
    }
  }

  // The deposit the buyer must send. The card quotes this before any tap.
  depositSats() {
    return this.priceSats + this.buyerFeeSats;
  }

  // The funding transaction landed. `sats` is what the chain says actually
  // arrived — the watcher speaks, the FSM believes only exact amounts.
  // An underpay refuses outright; an overpay is accepted and rides back
  // to the buyer as change at release. Nothing is ever rounded here:
  // the chain's number IS the number.
  fund(sats, { fundingBlock = 0 } = {}) {
    this.#assertState('draft', 'be funded twice.');
    if (typeof sats !== 'bigint' || sats < this.depositSats()) {
      throw new Error(`The deposit is short. Send at least ${this.depositSats()} satoshis.`);
    }
    this.state = 'funded';
    this.fundedSats = sats;
    this.fundingBlock = fundingBlock;
    return this.summary();
  }

  #elapsedBlocks(blockNow) {
    const now = typeof blockNow === 'bigint' ? blockNow : BigInt(Math.trunc(blockNow));
    return now > this.fundingBlock ? now - this.fundingBlock : 0n;
  }

  // The vendor's half-signature is already waiting; the buyer's one tap
  // completes it. Outputs the release transaction must pay, exactly.
  release() {
    this.#assertState('funded', 'be released.');
    const buyerChange = this.fundedSats - this.depositSats();
    return {
      vendorOutSats: this.priceSats - this.vendorFeeSats,
      feeOutSats: this.buyerFeeSats + this.vendorFeeSats,
      buyerChangeSats: buyerChange,
    };
  }

  #completeRelease() {
    this.state = 'released';
    return this.summary();
  }

  // A timeout refund only exists past the timer. The timer is blocks.
  timedRefundDue(blockNow) {
    if (this.state !== 'funded') return false;
    const due = BigInt(this.delayDays) * BigInt(BLOCKS_PER_DAY) === 0n
      ? true
      : this.#elapsedBlocks(blockNow) >= BigInt(this.delayDays) * BigInt(BLOCKS_PER_DAY);
    return due;
  }

  // kind 'timed'  : the timer ran out — buyer signs alone, chain-enforced.
  // kind 'admitted': vendor co-signs the refund early rather than waiting.
  // On EITHER path the whole deposit goes home and NO fee is charged:
  // the fee exists only on a settled deal.
  refund({ kind = 'timed', blockNow = 0n } = {}) {
    this.#assertState('funded', 'be refunded.');
    if (!REFUND_KINDS.includes(kind)) throw new Error(`Unknown refund kind: ${kind}.`);
    if (kind === 'timed' && !this.timedRefundDue(blockNow)) {
      throw new Error(`The refund timer has not run out. It unlocks after ${this.delayDays} days (blocks, not clock).`);
    }
    const out = { buyerOutSats: this.fundedSats, feeOutSats: 0n };
    this.state = 'refunded';
    return out;
  }

  // Convenience for the co-signed admitted refund path.
  admitRefund() {
    return this.refund({ kind: 'admitted' });
  }

  // The offered release, then the closing move. Split so the UI and the
  // PSBT builder can present THEN complete, but nothing changes state in
  // between except going through this door.
  proposeRelease() {
    return { outputs: this.release(), done: () => this.#completeRelease() };
  }

  summary() {
    return {
      state: this.state,
      priceSats: this.priceSats,
      delayDays: this.delayDays,
      buyerFeeSats: this.buyerFeeSats,
      vendorFeeSats: this.vendorFeeSats,
      fundedSats: this.fundedSats,
      fundingBlock: this.fundingBlock,
    };
  }
}

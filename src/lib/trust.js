import { normalizeAmount } from './proofOfTrade.js';

export const HALF_LIFE_SECONDS = 30 * 24 * 60 * 60;

export function decayWeight(at, now, halfLife = HALF_LIFE_SECONDS) {
  if (!Number.isInteger(at) || !Number.isInteger(now) || now < at || halfLife <= 0) return 0;
  return 2 ** (-(now - at) / halfLife);
}

function bodyOf(receipt) {
  return receipt?.body || receipt || {};
}

function roundScore(value) {
  return Math.round(value * 1e8) / 1e8;
}

function outcomeScore(receipt, now) {
  const body = bodyOf(receipt);
  const weight = decayWeight(body.at, now);
  if (!weight) return 0;
  let amount = 0;
  try {
    amount = Number(normalizeAmount(body.amount));
  } catch {
    return 0;
  }
  if (body.outcome === 'confirmed') return amount * weight;
  if (body.outcome === 'rugged') return -amount * weight;
  return 0;
}

export function reputation(receipts, now) {
  const totals = new Map();
  for (const receipt of receipts || []) {
    const vendor = bodyOf(receipt).vendor;
    if (!vendor) continue;
    totals.set(vendor, (totals.get(vendor) || 0) + outcomeScore(receipt, now));
  }
  return [...totals.entries()]
    .map(([vendor, score]) => ({ vendor, score: roundScore(score) }))
    .sort((a, b) => b.score - a.score || a.vendor.localeCompare(b.vendor));
}

export function rugRegistry(receipts) {
  const latest = new Map();
  for (const receipt of receipts || []) {
    const body = bodyOf(receipt);
    if (body.outcome !== 'rugged' || !body.vendor) continue;
    const prev = latest.get(body.vendor);
    if (!prev || (body.at || 0) >= prev.at) {
      latest.set(body.vendor, { vendor: body.vendor, at: body.at || 0, hash: receipt.hash || '' });
    }
  }
  return [...latest.values()].sort((a, b) => b.at - a.at || a.vendor.localeCompare(b.vendor));
}

export function arbitrationStatement({ hash, finding, arbitrator, at } = {}) {
  if (finding !== 'upheld' && finding !== 'denied') throw new Error('An arbitration finding is upheld or denied.');
  if (!hash || !arbitrator) throw new Error('An arbitration statement needs a receipt hash and an arbitrator.');
  return {
    v: 1,
    t: 'arbitration',
    hash: String(hash),
    finding,
    arbitrator: String(arbitrator).toLowerCase(),
    at: Number.isInteger(at) && at >= 0 ? at : 0,
  };
}

export function creditBetween(buyer, vendor, receipts, now) {
  let total = 0;
  for (const receipt of receipts || []) {
    const body = bodyOf(receipt);
    if (body.buyer !== buyer || body.vendor !== vendor || body.outcome !== 'confirmed') continue;
    try {
      total += Number(normalizeAmount(body.amount)) * decayWeight(body.at, now);
    } catch {
      /* a bad amount does not become credit */
    }
  }
  return roundScore(total);
}

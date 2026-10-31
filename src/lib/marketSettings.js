// Market settings the operator can change without a new build: today, the
// one destination the escrow fee is paid to.
//
// Two shapes, one row:
//
//   address   a fixed bc1 address. Simple, and linkable across every order.
//   xpub      a watch-only account key. Each order's fee pays a fresh
//             witness-v0 address derived from it, at an index picked from
//             the order id in 1..20 — the gap a wallet scans by default. So
//             the operator pastes the xpub of the wallet they already have
//             and collects every fee in it, and no two orders share an
//             address.
//
// The index comes from the order id, not from a counter: the vendor and the
// buyer must derive the SAME destination or their signatures do not match.
// A counter would drift between two devices. A hash of the order id cannot.
//
// Refusals that matter:
//   - a Monero address is refused in its own words. The escrow pays BTC; an
//     XMR string here could only "work" by someone converting units, which
//     is the bug class this repo is written against;
//   - a private key or a seed is refused: only a public xpub is ever read;
//   - a bad paste writes nothing, and an unreadable stored row reads as
//     unset, so a release is never built against a value this device cannot
//     parse back.

import { sha256 } from '@noble/hashes/sha2.js';
import { db } from '../db.js';
import { addressScriptHex } from './escrowSettle.js';
import { deriveBitcoinAddress } from './vendorPayments.js';

export const FEE_ADDRESS_KEY = 'market.feeAddress';

// First and last index a rotating xpub may use. A default wallet scans the
// first 20 addresses after the last one it spent, so staying inside this
// window is what makes "no new wallet needed" true.
export const FEE_ROTATION_FIRST = 1;
export const FEE_ROTATION_LAST = 20;

// A standard Monero address is base58 and starts 4 (or 8 for subaddresses).
// It is not bech32 and can never be a Bitcoin output.
const XMR_SHAPED = /^[48][0-9A-Za-z]{93,105}$/;
const XPUB_SHAPED = /^(xpub|tpub)[1-9A-HJ-NP-Za-km-z]{100,120}$/;
// A seed or a private key pasted into a public setting is a leak. Refuse it
// before it is written anywhere.
const SEED_SHAPED = /^([a-z]{3,8}\s+){11}[a-z]{3,8}$/;

// A fixed address, parsed into the one output script the release pays.
export function feeDestination(address) {
  const clean = String(address ?? '').trim();
  if (!clean) throw new Error('Paste the address the fee is paid to.');
  if (XMR_SHAPED.test(clean)) {
    throw new Error('That is a Monero address. The escrow pays Bitcoin, so the fee needs a bc1 address.');
  }
  const scriptHex = addressScriptHex(clean);
  return { kind: 'address', address: clean.toLowerCase(), scriptHex };
}

// The setting, whatever shape was pasted. Async because an xpub is checked
// by actually deriving from it.
export async function parseFeeSetting(value) {
  const clean = String(value ?? '').trim();
  if (!clean) throw new Error('Paste the address the fee is paid to.');
  if (SEED_SHAPED.test(clean)) {
    throw new Error('That is a wallet seed. Only a public xpub is used here; a seed is never stored.');
  }
  if (clean.split(/\s+/).length >= 12) {
    throw new Error('That looks like a seed phrase. Only a public xpub is used here; a seed is never stored.');
  }
  if (XPUB_SHAPED.test(clean)) {
    const { HDKey } = await import('@scure/bip32');
    let root;
    try {
      root = HDKey.fromExtendedKey(clean);
    } catch {
      throw new Error('That is not a usable xpub.');
    }
    if (!root.publicKey || root.privateKey) {
      throw new Error('Enter a public Bitcoin account xpub, not a private key.');
    }
    root.deriveChild(0).deriveChild(FEE_ROTATION_FIRST);
    return { kind: 'xpub', xpub: clean };
  }
  return feeDestination(clean);
}

// Which of the 1..20 addresses this order pays. Counted from the order id so
// both sides land on the same one without talking.
export function feeIndexFor(orderId) {
  const id = String(orderId ?? '');
  if (!id) throw new Error('A rotating fee needs an order id.');
  const digest = sha256(new TextEncoder().encode(id));
  const pick = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  const span = FEE_ROTATION_LAST - FEE_ROTATION_FIRST + 1;
  return FEE_ROTATION_FIRST + (pick % span);
}

// The output script the release pays for this order. A fixed address ignores
// the order; an xpub rotates.
export async function feeScriptFor(setting, orderId) {
  if (!setting) throw new Error('No fee destination is set.');
  if (setting.kind === 'address') return setting.scriptHex;
  if (setting.kind !== 'xpub') throw new Error('The stored fee destination is not readable.');
  const address = await deriveBitcoinAddress(setting.xpub, feeIndexFor(orderId), 'bc');
  return addressScriptHex(address);
}

// The setting, or null when none is set or the stored value no longer parses.
export async function readFeeSetting(table = null) {
  const target = table || db.settings;
  const row = await target.get(FEE_ADDRESS_KEY);
  if (!row || typeof row.value !== 'string' || !row.value) return null;
  try {
    return await parseFeeSetting(row.value);
  } catch {
    return null;
  }
}

// Save a new destination. Validates before anything is written, so a bad
// paste changes nothing.
export async function saveFeeSetting(value, table = null) {
  const target = table || db.settings;
  const setting = await parseFeeSetting(value);
  await target.put({ key: FEE_ADDRESS_KEY, value: setting.kind === 'xpub' ? setting.xpub : setting.address, kind: setting.kind });
  return setting;
}

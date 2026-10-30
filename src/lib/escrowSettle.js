// Escrow settlement spends: the three ways money leaves the box, and the
// admission envelope that records each one.
//
// Opened by item 1 of the market brief. A funded order closes one of
// exactly three ways:
//
//   release          OP_IF branch, vendor AND buyer sign.
//                    Vendor paid, 5% fee paid, any overpay back to the buyer.
//   admitted refund  OP_IF branch, vendor AND buyer sign.
//                    The vendor agrees to refund early; everything goes home,
//                    no fee. The chain cannot pay this early on OP_ELSE, so
//                    an early refund is a release-shaped spend with one output.
//   timed refund     OP_ELSE branch, the buyer signs ALONE after the clock.
//                    Everything goes home, no fee.
//
// Non-custody is stated in the code, not in a promise: buildTimedRefundSpend
// takes the buyer's own key and nothing from anyone else, and is built from
// the published script, the funding txid the watcher reported and the buyer's
// own derived key. Every server, peer, relay and this app can be switched off
// and the buyer still holds a transaction that pays them back. That is the
// property the whole market rests on, and item 1's proof.
//
// Money math is escrowFsm.js's. This file never computes a share itself; it
// calls the FSM and then checks that the outputs conserve the deposit to the
// satoshi. Script bytes are escrowScript.js's, and every spend is signed
// against the keys the script itself names, never against keys handed in.

import { bech32 } from '@scure/base';
import { Escrow } from './escrowFsm.js';
import { decodeOrderScript, hexToScript, scriptToHex } from './escrowScript.js';
import {
  finalizeReleaseTx,
  finalizeTimedRefundTx,
  verifySpendSignature,
} from './escrowPsbt.js';

const SCRIPT_HEX = /^[0-9a-f]+$/;

function asSats(value, what) {
  if (typeof value !== 'bigint') throw new Error(`${what} must be a whole number of satoshis.`);
  if (value < 0n) throw new Error(`${what} cannot be negative.`);
  return value;
}

function asHex(value) {
  const clean = String(value ?? '').trim().toLowerCase();
  if (!SCRIPT_HEX.test(clean) || clean.length % 2 !== 0) {
    throw new Error('That is not a script: it must be even-length hex.');
  }
  return clean;
}

// A payout to one key, as Bitcoin script: OP_PUSH33 <key> OP_CHECKSIG.
// Used for every party payout in this file, so a payout destination is a
// key, never an address string that has to be re-parsed.
export function p2pkScriptHex(publicKeyHex) {
  const key = asHex(publicKeyHex);
  if (key.length !== 66 || !/^0[23]/.test(key)) {
    throw new Error('A payout names one 33-byte compressed public key.');
  }
  return `21${key}ac`;
}

// A pasted pay-to-witness-key-hash or pay-to-witness-script-hash address,
// turned into its output script. Strict: witness v0 only, and only the two
// program lengths v0 defines. This is how an operator's fee address becomes
// the fee output script, with no dependency beyond the bech32 already here.
export function addressScriptHex(address, { network = 'main' } = {}) {
  const hrp = { main: 'bc', test: 'tb', regtest: 'bcrt' }[network];
  if (!hrp) throw new Error(`Unknown Bitcoin network: ${network}.`);
  const clean = String(address ?? '').trim().toLowerCase();
  let decoded;
  try {
    decoded = bech32.decode(clean);
  } catch {
    throw new Error('That is not a bech32 address.');
  }
  if (decoded.prefix !== hrp) throw new Error(`That address is not a ${network} address.`);
  const [version, ...words] = decoded.words;
  let program;
  try {
    program = bech32.fromWords(words);
  } catch {
    throw new Error('That address does not decode to whole bytes.');
  }
  if (version !== 0) throw new Error('Only witness v0 addresses are supported.');
  if (program.length === 20) return `0014${scriptToHex(program)}`;
  if (program.length === 32) return `0020${scriptToHex(program)}`;
  throw new Error('A witness v0 address holds a 20- or 32-byte program.');
}

// The funded deal, through the FSM, so the money table stays in one place.
function fundedDeal(priceSats, fundedSats) {
  if (typeof priceSats !== 'bigint') throw new Error('The order price must be whole satoshis.');
  const deal = new Escrow({ priceSats });
  // fund() refuses a short deposit and keeps an overpay whole.
  deal.fund(asSats(fundedSats, 'The funded amount'));
  return deal;
}

// The release outputs, exactly as the FSM table names them: vendor out, fee
// out, and the buyer's change (an overpay, or nothing). The miner fee is real
// and comes out of the buyer's change; it can never make an output vanish.
export function releaseOutputs({ priceSats, fundedSats, minerFeeSats = 0n, vendorPubHex, buyerPubHex, feeScriptHex }) {
  const deal = fundedDeal(priceSats, fundedSats);
  const { vendorOutSats, feeOutSats, buyerChangeSats } = deal.release();
  const miner = asSats(minerFeeSats, 'The miner fee');
  if (buyerChangeSats < miner) {
    throw new Error('The miner fee does not fit in the buyer’s change.');
  }
  // A release with no fee destination cannot happen. The 5% has an address
  // or the deal does not settle; there is no default and no operator key.
  const feeScript = asHex(feeScriptHex);
  if (feeOutSats === 0n) throw new Error('A release pays no fee; that is a refund, not a release.');
  const outputs = [
    { sats: vendorOutSats, scriptHex: p2pkScriptHex(vendorPubHex) },
    { sats: feeOutSats, scriptHex: feeScript },
  ];
  const change = buyerChangeSats - miner;
  if (change > 0n) outputs.push({ sats: change, scriptHex: p2pkScriptHex(buyerPubHex) });
  const sum = outputs.reduce((n, out) => n + out.sats, 0n);
  if (sum + miner !== fundedSats) {
    throw new Error('The release does not conserve the deposit. Refusing to sign it.');
  }
  return outputs;
}

// The refund outputs: the whole deposit home, no fee, the miner fee taken
// out of the trip. One output, to the script's own buyer key.
export function refundOutputs({ priceSats, fundedSats, minerFeeSats = 0n, buyerPubHex }) {
  const deal = fundedDeal(priceSats, fundedSats);
  // Both refund kinds share this table: the money is the same, only the
  // branch that spends it differs. The clock is enforced by the chain and
  // by the membrane, not by this arithmetic.
  const { buyerOutSats, feeOutSats } = deal.refund({ kind: 'admitted' });
  if (feeOutSats !== 0n) throw new Error('A refund never charges the fee.');
  const miner = asSats(minerFeeSats, 'The miner fee');
  const home = buyerOutSats - miner;
  if (home <= 0n) throw new Error('The miner fee leaves the refund with nothing to send home.');
  return [{ sats: home, scriptHex: p2pkScriptHex(buyerPubHex) }];
}

// The parties and the clock, read from the script. Both builders use this,
// so the keys that sign are always the keys the script verifies.
export function scriptParties(scriptHex) {
  const clean = asHex(scriptHex);
  const decoded = decodeOrderScript(hexToScript(clean));
  if (!decoded) {
    throw new Error('That script is not the exact two-branch escrow shape. Nothing signs it.');
  }
  return {
    scriptHex: clean,
    vendorPubHex: scriptToHex(decoded.vendorPubKey),
    buyerPubHex: scriptToHex(decoded.buyerPubKey),
    delayBlocks: decoded.delayBlocks,
  };
}

function fundingFacts(funding) {
  if (!funding || typeof funding !== 'object') throw new Error('A spend needs the funding it spends.');
  const txid = String(funding.txid ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('The funding txid must be 64 hex characters.');
  const vout = funding.vout ?? 0;
  if (!Number.isInteger(vout) || vout < 0) throw new Error('The funding output index is a whole number.');
  return { txid, vout, sats: asSats(funding.sats, 'The funding amount'), scriptHex: asHex(funding.scriptHex) };
}

// Every signature is checked against the script's own key before the spend
// leaves this function, so a swapped key cannot ride out under a correct
// looking transaction.
function verifyOne({ signatureBytes, pubHex, digest, who }) {
  if (!verifySpendSignature({ signatureBytes, publicKeyBytes: hexToScript(pubHex), digest })) {
    throw new Error(`The ${who}’s signature does not verify against the script. Refusing the spend.`);
  }
}

export function buildReleaseSpend({
  funding,
  priceSats,
  minerFeeSats = 0n,
  feeScriptHex,
  vendorKeyBytes,
  buyerKeyBytes,
}) {
  const facts = fundingFacts(funding);
  const parties = scriptParties(facts.scriptHex);
  const outputs = releaseOutputs({
    priceSats,
    fundedSats: facts.sats,
    minerFeeSats,
    vendorPubHex: parties.vendorPubHex,
    buyerPubHex: parties.buyerPubHex,
    feeScriptHex,
  });
  const spend = finalizeReleaseTx({
    fundingTxid: facts.txid,
    fundingVout: facts.vout,
    fundingSats: facts.sats,
    witnessScriptHex: facts.scriptHex,
    outputs,
    vendorKeyBytes,
    buyerKeyBytes,
  });
  verifyOne({ signatureBytes: spend.vendorSig, pubHex: parties.vendorPubHex, digest: spend.digest, who: 'vendor' });
  verifyOne({ signatureBytes: spend.buyerSig, pubHex: parties.buyerPubHex, digest: spend.digest, who: 'buyer' });
  return { ...spend, outputs, parties };
}

// The vendor agrees to refund early. The chain cannot pay OP_ELSE before the
// clock, so both keys take the release branch and the one output goes home.
export function buildAdmittedRefundSpend({
  funding,
  priceSats,
  minerFeeSats = 0n,
  vendorKeyBytes,
  buyerKeyBytes,
}) {
  const facts = fundingFacts(funding);
  const parties = scriptParties(facts.scriptHex);
  const outputs = refundOutputs({
    priceSats,
    fundedSats: facts.sats,
    minerFeeSats,
    buyerPubHex: parties.buyerPubHex,
  });
  const spend = finalizeReleaseTx({
    fundingTxid: facts.txid,
    fundingVout: facts.vout,
    fundingSats: facts.sats,
    witnessScriptHex: facts.scriptHex,
    outputs,
    vendorKeyBytes,
    buyerKeyBytes,
  });
  verifyOne({ signatureBytes: spend.vendorSig, pubHex: parties.vendorPubHex, digest: spend.digest, who: 'vendor' });
  verifyOne({ signatureBytes: spend.buyerSig, pubHex: parties.buyerPubHex, digest: spend.digest, who: 'buyer' });
  if (outputs.length !== 1 || outputs[0].scriptHex !== p2pkScriptHex(parties.buyerPubHex)) {
    throw new Error('A refund pays the script’s own buyer key and nobody else.');
  }
  return { ...spend, outputs, parties };
}

// The buyer alone, after the clock. No vendor key, no peer, no server.
// `blockNow`/`fundingHeight` are optional, but when given the builder refuses
// to hand over a transaction the chain would reject for being early.
export function buildTimedRefundSpend({
  funding,
  priceSats,
  minerFeeSats = 0n,
  buyerKeyBytes,
  blockNow = null,
  fundingHeight = null,
}) {
  const facts = fundingFacts(funding);
  const parties = scriptParties(facts.scriptHex);
  if (blockNow !== null || fundingHeight !== null) {
    if (!Number.isFinite(blockNow) || !Number.isFinite(fundingHeight)) {
      throw new Error('A clock check needs both the funding height and the current height.');
    }
    if (blockNow < fundingHeight + parties.delayBlocks) {
      throw new Error(`The refund timer has not run out. It unlocks ${parties.delayBlocks} blocks after funding.`);
    }
  }
  const outputs = refundOutputs({
    priceSats,
    fundedSats: facts.sats,
    minerFeeSats,
    buyerPubHex: parties.buyerPubHex,
  });
  const spend = finalizeTimedRefundTx({
    fundingTxid: facts.txid,
    fundingVout: facts.vout,
    fundingSats: facts.sats,
    witnessScriptHex: facts.scriptHex,
    outputs,
    delayBlocks: parties.delayBlocks,
    buyerKeyBytes,
  });
  verifyOne({ signatureBytes: spend.buyerSig, pubHex: parties.buyerPubHex, digest: spend.digest, who: 'buyer' });
  if (outputs.length !== 1 || outputs[0].scriptHex !== p2pkScriptHex(parties.buyerPubHex)) {
    throw new Error('A refund pays the script’s own buyer key and nobody else.');
  }
  return { ...spend, outputs, parties };
}

// The settlement as the membrane records it: one chain fact, said once.
// The operation id names the txid, so the same settlement seen twice is a
// duplicate and never a second effect.
export function settleEnvelope({ type, txid, kind, height, orderId, expectedRevision }) {
  if (type !== 'escrow_release' && type !== 'escrow_refund') {
    throw new Error('A settlement is a release or a refund.');
  }
  const fact = String(txid ?? '').trim().toLowerCase();
  const payload = { type, expectedRevision, txid: fact };
  if (type === 'escrow_refund') payload.kind = kind;
  if (type === 'escrow_refund') payload.height = height;
  return {
    schemaVersion: 1,
    operationId: `settle:${type}:${fact}`,
    principal: 'watcher',
    ...(orderId !== undefined ? { orderId } : {}),
    payload,
  };
}

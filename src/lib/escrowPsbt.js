// Escrow spend mechanics (commit 4 of docs/ESCROW.md): the P2WSH address
// the deposit pays, BIP-143 sighash, signatures, and a minimal BIP-174
// PSBT for the escape hatch. No new dependencies: @noble/curves signs,
// @noble/hashes hashes, @scure/base encodes the address.
//
// Layer rules:
// - This file never decides WHERE money goes. The FSM (escrowFsm.js)
//   names the outputs; this file puts them on the wire exactly as named.
// - A miner fee is real and cannot vanish: the builder refuses to pay
//   out more than the escrow actually funded, and outputs are the
//   caller's explicit list, never invented here.
// - Every spend input is the escrow utxo itself; the witness script is
//   checked byte-for-byte against the exact 2-of-2 shape (escrowScript)
//   before anything signs.

import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
// Bitcoin rule (BIP-350): witness version 0 addresses are bech32; only
// v1+ (taproot) uses bech32m. All escrow spends are v0, so the deposit
// address encodes with plain bech32.
import { bech32, base64 } from '@scure/base';
import { decodeOrderScript } from './escrowScript.js';

export const SIGHASH_ALL = 0x01;
const LEARLY_RELEASE_SEQUENCE = 0xffffffff; // release branch never executes CSV

function hexToBytes(hex) {
  const clean = String(hex ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('That hex is not even hex.');
  }
  return Uint8Array.from((clean.match(/../g) || []).map((pair) => parseInt(pair, 16)));
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const part of parts) {
    out.set(part, i);
    i += part.length;
  }
  return out;
}

function u32LE(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64LE(bigish) {
  const value = BigInt(bigish);
  if (value < 0n || value >= 2n ** 64n) throw new Error('A Bitcoin value must fit in 64 bits.');
  const out = new Uint8Array(8);
  let rest = value;
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function compactSize(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error('A protocol size must be a whole count.');
  if (value < 253) return Uint8Array.from([value]);
  if (value <= 0xffff) return concat([Uint8Array.from([253]), u32LE(value).slice(0, 2)]);
  if (value <= 0xffffffff) return concat([Uint8Array.from([254]), u32LE(value)]);
  return concat([Uint8Array.from([255]), u64LE(value)]);
}

function scriptPush(bytes) {
  return concat([compactSize(bytes.length), bytes]);
}

export const doubleSha256 = (bytes) => sha256(sha256(bytes));

// ------------------------------------------------------------------
// The deposit: the P2WSH address for the escrow script.
// ------------------------------------------------------------------
const NETWORK_HRP = { main: 'bc', test: 'tb', regtest: 'bcrt' };

export function escrowAddress(scriptBytes, { network = 'main' } = {}) {
  const hrp = NETWORK_HRP[network];
  if (!hrp) throw new Error(`Unknown Bitcoin network: ${network}.`);
  const program = sha256(scriptBytes); // P2WSH: sha256 of the script
  // witness v0: BECH32 checksum data (version byte then the sha256 program)
  return bech32.encode(hrp, [0, ...bech32.toWords(program)]);
}

// ------------------------------------------------------------------
// Signature digests (BIP-143, P2WSH, SIGHASH_ALL -- the only mode a
// two-party close needs; ANYONECANPAY and friends are not implemented
// on purpose).
// ------------------------------------------------------------------

function inputOutpoint(input) {
  return concat([hexToBytes(input.txidHex).slice().reverse(), u32LE(input.vout)]);
}

function outputBytes(output) {
  return concat([u64LE(output.sats), scriptPush(hexToBytes(output.scriptHex))]);
}

// BIP-143 P2WSH digest for an already-built single-input spend tx.
// Accepts ANY scriptCode hex — the escrow wrapper below is the one that
// insists on the exact 2-of-2 shape; this raw form is what the Bitcoin
// test vectors anchor.
export function bip143Digest({ tx, vinIndex = 0, scriptCodeHex, prevAmountSats }) {
  if (tx.vin.length !== 1) {
    // Every escrow spend is one utxo in, outputs out. Keeping this to a
    // single input makes hashPrevouts == the one outpoint and keeps the
    // preimage honest without loops.
    throw new Error('An escrow spend has exactly one input: the escrow itself.');
  }
  const input = tx.vin[vinIndex];
  const scriptCode = concat([compactSize(hexToBytes(scriptCodeHex).length), hexToBytes(scriptCodeHex)]);
  const hashPrevouts = doubleSha256(inputOutpoint(input));
  const hashSequence = doubleSha256(u32LE(input.sequence));
  const hashOutputs = doubleSha256(concat(tx.vout.map(outputBytes)));
  const preimage = concat([
    u32LE(tx.version),
    hashPrevouts,
    hashSequence,
    inputOutpoint(input),
    scriptCode,
    u64LE(prevAmountSats),
    u32LE(input.sequence),
    hashOutputs,
    u32LE(tx.locktime),
    u32LE(SIGHASH_ALL),
  ]);
  return doubleSha256(preimage);
}

export function p2wshSignatureDigest({ tx, vinIndex, witnessScriptHex, prevAmountSats }) {
  const script = hexToBytes(witnessScriptHex);
  if (!decodeOrderScript(script)) {
    throw new Error('A spend refuses to sign for a script that is not the exact escrow shape.');
  }
  return bip143Digest({ tx, vinIndex, scriptCodeHex: witnessScriptHex, prevAmountSats });
}

// ------------------------------------------------------------------
// Transactions.
// ------------------------------------------------------------------

// Outputs are explicit and conserving at the trust boundary: the caller
// passes exactly the FSM table plus a miner fee taken from one of them.
export function buildSpendTx({ fundingTxid, fundingVout = 0, fundingSats, witnessScriptHex, outputs, sequence, locktime = 0 }) {
  if (!decodeOrderScript(hexToBytes(witnessScriptHex))) {
    throw new Error('A spend is built only for the exact escrow script.');
  }
  if (typeof fundingSats !== 'bigint' || fundingSats <= 0n) {
    throw new Error('The funding amount must be a positive whole number of satoshis.');
  }
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new Error('A spend must name its outputs.');
  }
  let outSum = 0n;
  for (const out of outputs) {
    if (typeof out.sats !== 'bigint' || out.sats <= 0n) {
      throw new Error('Every output must pay a positive whole number of satoshis.');
    }
    if (!/^[0-9a-f]+$/.test(String(out.scriptHex))) {
      throw new Error('Every output needs a script.');
    }
    outSum += out.sats;
  }
  if (outSum > fundingSats) {
    throw new Error('A spend cannot pay out more than the escrow holds. Outputs overreach.');
  }
  const vin = [{
    txidHex: String(fundingTxid).toLowerCase(),
    vout: fundingVout,
    sequence,
    amountSats: fundingSats,
  }];
  return { version: 2, vin, vout: outputs, locktime };
}

function noWitnessTx(tx) {
  const parts = [u32LE(tx.version), compactSize(tx.vin.length)];
  for (const input of tx.vin) {
    parts.push(inputOutpoint(input), compactSize(0), u32LE(input.sequence));
  }
  parts.push(compactSize(tx.vout.length));
  for (const out of tx.vout) parts.push(outputBytes(out));
  parts.push(u32LE(tx.locktime));
  return concat(parts);
}

// The funding utxo must exist to be spent: the txid quoted here is the
// txid the WATCHER reported, and the spend is only ever built against a
// membrane-confirmed fact. This is the txid-derivation cross-check.
export function spendTxId(tx) {
  return bytesToHex(doubleSha256(noWitnessTx(tx)).reverse());
}

function witnessTx(tx, witnessStacks) {
  const parts = [u32LE(tx.version), Uint8Array.from([0x00, 0x01]), compactSize(tx.vin.length)];
  for (const input of tx.vin) {
    parts.push(inputOutpoint(input), compactSize(0), u32LE(input.sequence));
  }
  parts.push(compactSize(tx.vout.length));
  for (const out of tx.vout) parts.push(outputBytes(out));
  for (const stack of witnessStacks) {
    parts.push(compactSize(stack.length));
    for (const item of stack) parts.push(compactSize(item.length), item);
  }
  parts.push(u32LE(tx.locktime));
  return concat(parts);
}

// Witness sig format: DER + one SIGHASH_ALL byte.
export function signSpend({ privateKeyBytes, digest }) {
  if (privateKeyBytes instanceof Uint8Array !== true || privateKeyBytes.length !== 32) {
    throw new Error('Sign with a 32-byte private key.');
  }
  const der = secp256k1.sign(digest, privateKeyBytes, { prehash: false, format: 'der' });
  return concat([der, Uint8Array.from([SIGHASH_ALL])]);
}

export function verifySpendSignature({ signatureBytes, publicKeyBytes, digest }) {
  const der = signatureBytes.slice(0, signatureBytes.length - 1); // drop the sighash byte
  return secp256k1.verify(der, digest, publicKeyBytes, { format: 'der', prehash: false, lowS: true });
}

// The witness stacks, in bottom-to-top order the way the script pops them:
//   release branch : [ buyerSig, vendorSig, 0x01 ]  (the control byte is what
//                     OP_IF consumes; sigs then meet CHECKSIGVERIFY/CHECKSIG)
//   refund branch  : [ buyerSig, empty ]            (empty element = false)
//   dead drop      : [ vendorSig, preimage, 0x01, empty ]
//                     the outer OP_IF pops empty (false) -> OP_ELSE; the
//                     inner OP_IF pops 0x01 (true) -> the overt body,
//                     where OP_SHA256 consumes the preimage and
//                     OP_CHECKSIG consumes the vendor sig — the vendor
//                     signs ALONE in the branch designed to be fired alone.
export const RELEASE_WITNESS_CONTROL = Uint8Array.from([0x01]);
export const REFUND_WITNESS_CONTROL = Uint8Array.from([]);

export function finalizeReleaseTx({ fundingTxid, fundingVout = 0, fundingSats, witnessScriptHex, outputs, vendorKeyBytes, buyerKeyBytes }) {
  const tx = buildSpendTx({
    fundingTxid, fundingVout, fundingSats, witnessScriptHex, outputs, sequence: LEARLY_RELEASE_SEQUENCE,
  });
  const digest = p2wshSignatureDigest({ tx, vinIndex: 0, witnessScriptHex, prevAmountSats: fundingSats });
  const vendorSig = signSpend({ privateKeyBytes: vendorKeyBytes, digest });
  const buyerSig = signSpend({ privateKeyBytes: buyerKeyBytes, digest });
  const bytes = witnessTx(tx, [[buyerSig, vendorSig, RELEASE_WITNESS_CONTROL]]);
  return { tx, digest, vendorSig, buyerSig, bytes: hexOf(bytes), txid: txidOf(bytes) };
}

// The Dead Drop close: the vendor returns ALL the money, fee-free, any
// time — and cannot do it without publishing the delivery preimage
// on-chain. The honesty line rides with it everywhere it ships: this
// proves the vendor ASSERTED delivery, not that atoms moved. The
// outputs here are ENFORCED, not caller-chosen: exactly one output,
// paying the buyer's key the way the refund branch names it — bare
// P2PK of the script's buyer key. A vendor with a foreign wallet can
// craft different bytes, since no script binds destinations without
// CTV, but the chain is public and the membrane only admits the
// report when the same two facts check out there (orderMembrane).
// The commitment is cross-checked before anything signs: the chain
// would refuse a wrong preimage, so a ghost signature is never born
// already-failed.
const P2PK = (pubkeyBytes) => Uint8Array.from([0x21, ...pubkeyBytes, 0xac]);

export function finalizeOvertRefundTx({ fundingTxid, fundingVout = 0, fundingSats, witnessScriptHex, outputs, preimageBytes, vendorKeyBytes }) {
  if (preimageBytes instanceof Uint8Array !== true || preimageBytes.length !== 32) {
    throw new Error('The dead drop opens with the 32-byte delivery nonce.');
  }
  const decoded = decodeOrderScript(hexToBytes(witnessScriptHex));
  if (!decoded || decoded.overtHash === null) {
    throw new Error('A dead drop close needs the Dead Drop script, not the plain box.');
  }
  if (bytesToHex(sha256(preimageBytes)) !== bytesToHex(decoded.overtHash)) {
    throw new Error('The preimage does not open this dead drop: its SHA-256 is not the committed hash.');
  }
  // (re-attack round 2: the partial-money lie — this builder could
  // mint an overt spend paying anywhere. It now has exactly one way
  // to build the money table: all of it, to the buyer, fee-free.)
  if (!Array.isArray(outputs) || outputs.length !== 1) {
    throw new Error('The dead drop returns ALL the money: it spends into exactly one output.');
  }
  if (typeof outputs[0]?.sats !== 'bigint' || outputs[0].sats <= 0n || outputs[0].sats > fundingSats) {
    throw new Error('The dead drop pays the buyer what the escrow holds (the miner fee is the only remainder).');
  }
  if (String(outputs[0]?.scriptHex ?? '') !== bytesToHex(P2PK(decoded.buyerPubKey))) {
    throw new Error('The dead drop pays the buyer key named in the script — every sat home, fee-free.');
  }
  const tx = buildSpendTx({
    fundingTxid, fundingVout, fundingSats, witnessScriptHex, outputs, sequence: LEARLY_RELEASE_SEQUENCE,
  });
  const digest = p2wshSignatureDigest({ tx, vinIndex: 0, witnessScriptHex, prevAmountSats: fundingSats });
  const vendorSig = signSpend({ privateKeyBytes: vendorKeyBytes, digest });
  const bytes = witnessTx(tx, [[vendorSig, preimageBytes, RELEASE_WITNESS_CONTROL, REFUND_WITNESS_CONTROL]]);
  return { tx, digest, vendorSig, bytes: hexOf(bytes), txid: txidOf(bytes) };
}

// The Clock Box claim: the founder's day-20 rule. Buyer silence at the
// clock frees the vendor — alone, with the SAME delivery preimage the
// dead drop refunds on, ALL the money home, fee-free by founder order
// (the 5% exists only on the cooperative release). The money table is
// ENFORCED here, exactly one output paying the vendor's key as bare
// P2PK — the no-CTV law again: the script binds who may sign and what
// is known, and this builder binds WHERE, for money this app mints.
// A foreign wallet can craft different bytes, but the chain is public
// and the membrane only admits the report when the same facts check
// out. The honesty limit rides unchanged: the claim records the
// vendor's ASSERTED delivery, not atoms.
export function finalizeClockClaimTx({ fundingTxid, fundingVout = 0, fundingSats, witnessScriptHex, outputs, preimageBytes, vendorKeyBytes }) {
  if (preimageBytes instanceof Uint8Array !== true || preimageBytes.length !== 32) {
    throw new Error('The clock claim opens with the 32-byte delivery nonce.');
  }
  const decoded = decodeOrderScript(hexToBytes(witnessScriptHex));
  if (!decoded || decoded.claimBlocks === null) {
    throw new Error('A clock claim needs the Clock Box script, not the plain box or the dead drop.');
  }
  if (bytesToHex(sha256(preimageBytes)) !== bytesToHex(decoded.overtHash)) {
    throw new Error('The preimage does not open this clock claim: its SHA-256 is not the committed hash.');
  }
  if (!Array.isArray(outputs) || outputs.length !== 1) {
    throw new Error('The clock claim takes ALL the money: it spends into exactly one output.');
  }
  if (typeof outputs[0]?.sats !== 'bigint' || outputs[0].sats <= 0n || outputs[0].sats > fundingSats) {
    throw new Error('The clock claim pays the vendor what the escrow holds (the miner fee is the only remainder).');
  }
  if (String(outputs[0]?.scriptHex ?? '') !== bytesToHex(P2PK(decoded.vendorPubKey))) {
    throw new Error('The clock claim pays the vendor key named in the script — every sat home, fee-free.');
  }
  const tx = buildSpendTx({
    fundingTxid, fundingVout, fundingSats, witnessScriptHex, outputs,
    sequence: decoded.claimBlocks, // the input sequence IS the CSV clock
  });
  const digest = p2wshSignatureDigest({ tx, vinIndex: 0, witnessScriptHex, prevAmountSats: fundingSats });
  const vendorSig = signSpend({ privateKeyBytes: vendorKeyBytes, digest });
  const bytes = witnessTx(tx, [[vendorSig, preimageBytes, RELEASE_WITNESS_CONTROL, REFUND_WITNESS_CONTROL, REFUND_WITNESS_CONTROL]]);
  return { tx, digest, vendorSig, bytes: hexOf(bytes), txid: txidOf(bytes) };
}

export function finalizeTimedRefundTx({ fundingTxid, fundingVout = 0, fundingSats, witnessScriptHex, outputs, delayBlocks, buyerKeyBytes }) {
  if (!delayBlocks) throw new Error('A timed refund needs the script delay.');
  const tx = buildSpendTx({
    fundingTxid, fundingVout, fundingSats, witnessScriptHex, outputs,
    sequence: delayBlocks, // the input sequence IS the CSV clock
  });
  const digest = p2wshSignatureDigest({ tx, vinIndex: 0, witnessScriptHex, prevAmountSats: fundingSats });
  const buyerSig = signSpend({ privateKeyBytes: buyerKeyBytes, digest });
  const bytes = witnessTx(tx, [[buyerSig, REFUND_WITNESS_CONTROL]]);
  return { tx, digest, buyerSig, bytes: hexOf(bytes), txid: txidOf(bytes) };
}

function hexOf(bytes) {
  return bytesToHex(bytes ?? new Uint8Array());
}

function txidOf(bytes) {
  return bytesToHex(bytes ? doubleSha256(bytes).slice().reverse() : new Uint8Array(32));
}

export { hexOf as toHex, txidOf as txidFromBytes };

// ------------------------------------------------------------------
// Escape-hatch PSBT (minimal BIP-174): enough for a foreign wallet to
// take over exactly one escrow utxo and finish the deal end. Fields:
// the unsigned tx, the witness utxo, the witness script, the partial
// signatures seen so far. Everything else is other people's business.
// ------------------------------------------------------------------

function encodeKeyPair(key, value) {
  return concat([compactSize(key.length), key, compactSize(value.length), value]);
}

export function buildEscrowPsbt({ fundingTxid, fundingVout = 0, fundingSats, witnessScriptHex, outputs, kind = 'release', delayBlocks, locktime = 0 }) {
  // The escape hatch comes in BOTH close variants. The release branch
  // spends with 0xffffffff -- the CSV disable flag, fine. The refund
  // branch spends with sequence = delayBlocks: without it a foreign
  // wallet holds a PSBT whose embedded sequence OP_CSV can never pass,
  // and the escape hatch is no refund hatch at all. (re-attack round
  // @ 52cbdab: the first draft was release-only.)
  //
  // There is deliberately NO dead-drop PSBT kind: the overt branch
  // publishes the delivery preimage — the vendor's attestation lives in
  // the spend itself. Hand-off files leak the nonce without the money
  // moving, so finalizeOvertRefundTx signs alone, in-app, never here.
  if (kind !== 'release' && kind !== 'timed-refund') throw new Error(`Unknown PSBT kind: ${kind}.`);
  if (kind === 'timed-refund' && !delayBlocks) throw new Error('A timed-refund PSBT needs the script delay.');
  const tx = buildSpendTx({
    fundingTxid, fundingVout, fundingSats, witnessScriptHex, outputs,
    sequence: kind === 'timed-refund' ? delayBlocks : LEARLY_RELEASE_SEQUENCE, locktime,
  });
  const script = hexToBytes(witnessScriptHex);
  const outpointScript = concat([Uint8Array.from([0x00, 0x20]), sha256(script)]);

  const globalMap = concat([
    encodeKeyPair(Uint8Array.from([0x00]), noWitnessTx(tx)),
  ]);
  const inputMap = concat([
    encodeKeyPair(Uint8Array.from([0x01]), concat([u64LE(fundingSats), outpointScript])),
    encodeKeyPair(Uint8Array.from([0x04]), script),
  ]);
  const outputMaps = tx.vout.map(() => Uint8Array.of());
  const parts = [
    Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff]), // "psbt\xff"
    globalMap,
    Uint8Array.from([0x00]), // global separator
    inputMap,
    Uint8Array.from([0x00]),
    ...outputMaps.flatMap((m) => [m, Uint8Array.from([0x00])]),
  ];
  return { bytes: concat(parts), tx };
}

export function psbtBase64(psbt) {
  return base64.encode(psbt.bytes instanceof Uint8Array ? psbt.bytes : psbt);
}

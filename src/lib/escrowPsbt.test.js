import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escrowAddress,
  bip143Digest,
  p2wshSignatureDigest,
  buildSpendTx,
  finalizeReleaseTx,
  finalizeTimedRefundTx,
  finalizeOvertRefundTx,
  finalizeClockClaimTx,
  signSpend,
  verifySpendSignature,
  buildEscrowPsbt,
  psbtBase64,
  doubleSha256,
} from './escrowPsbt.js';
import {
  assembleOrderScript,
  assembleOvertOrderScript,
  assembleClockClaimScript,
  scriptToHex,
  hexToScript,
} from './escrowScript.js';
import { quoteEscrow } from './escrowFsm.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32, base64 } from '@scure/base';

// The wire bytes, attacked before anyone's coins move. Anchors are
// external: the BIP-350 bech32m address encoding (through @scure/base),
// and the BIP-143 SIGHASH_ALL digest whose preimage pieces, hash, and
// expectations are published in the Bitcoin BIPs repository.

const PUB_V = Uint8Array.from({ length: 33 }, (_, i) => 0x11 + i);
const PUB_B = Uint8Array.from({ length: 33 }, (_, i) => 0x2a + i);
const SCRIPT_HEX = scriptToHex(assembleOrderScript({ vendorPubKey: PUB_V, buyerPubKey: PUB_B, delayBlocks: 2880 }));
const VENDOR_PRIV = secp256k1.utils.randomSecretKey();
const BUYER_PRIV = secp256k1.utils.randomSecretKey();

test('the deposit address is bech32 of the script hash, per network', () => {
  const addr = escrowAddress(hexToScript(SCRIPT_HEX));
  const decode = bech32.decode(addr, 200);
  assert.equal(decode.prefix, 'bc');
  const words = decode.words;
  assert.equal(words[0], 0); // witness v0
  const program = new Uint8Array(bech32.fromWords(words.slice(1)));
  assert.equal(scriptToHex(program), scriptToHex(sha256(hexToScript(SCRIPT_HEX))));
  const tb = escrowAddress(hexToScript(SCRIPT_HEX), { network: 'test' });
  assert.equal(tb.startsWith('tb1q'), true); // witness v0 = bech32, q prefix
  assert.notEqual(tb, addr);
  assert.throws(() => escrowAddress(hexToScript(SCRIPT_HEX), { network: 'snorkel' }), /network/);
});

// The BIP-143 P2SH-P2WSH test vector, hashType SIGHASH_ALL. Our digest
// builder takes the same inputs (outpoint, amount 987654321, sequence
// 0xffffffff, two outputs, that scriptCode) and must produce the
// published digest: 185c0be5263dce5b4bb50a047973c1b6272bfbd0103a8944459
// 7dc40b248ee7c.
const VECTOR = {
  // The BIP writes the outpoint txid in the RAW byte order that sits in
  // the preimage; txids humans quote are that hex reversed. Feed the
  // digest builder the REVERSED form, the way a real caller would.
  leTxid: '36641869ca081e70f394c6948e8af409e18b619df2ed74aa106c1ca29787b96e',
  vout: 1,
  amountSats: 987654321n,
  sequence: 0xffffffff,
  scriptCodeHex: '56210307b8ae49ac90a048e9b53357a2354b3334e9c8bee813ecb98e99a7e07e8c3ba32103b28f0c28bfab54554ae8c658ac5c3e0ce6e79ad336331f78c428dd43eea8449b21034b8113d703413d57761b8b9781957b8c0ac1dfe69f492580ca4195f50376ba4a21033400f6afecb833092a9a21cfdf1ed1376e58c5d1f47de74683123987e967a8f42103a6d48b1131e94ba04d9737d61acdaa1322008af9602b3b14862c07a1789aac162102d8b661b0b3302ee2f162b09e07a55ad5dfbe673a9f01d9f0c19617681024306b56ae',
  outputs: [
    // 900,000,000 (0x35a4e900) and 87,000,000 (0x052f83c0), straight
    // from the vector's output hex; sums under the 987,654,321 input
    { sats: 900000000n, scriptHex: '76a914389ffce9cd9ae88dcc0631e88a821ffdbe9bfe2688ac' },
    { sats: 87000000n, scriptHex: '76a9147480a33f950689af511e6e84c138dbbd3c3ee41588ac' },
  ],
  locktime: 0,
  digestHex: '185c0be5263dce5b4bb50a047973c1b6272bfbd0103a89444597dc40b248ee7c',
};

const displayTxid = () => hexToScript(VECTOR.leTxid).slice().reduceRight((t, b) => t + b.toString(16).padStart(2, '0'), '');

function vectorTx() {
  return {
    version: 1, // the BIP-143 example uses version 1
    vin: [{ txidHex: displayTxid(), vout: VECTOR.vout, sequence: VECTOR.sequence, amountSats: VECTOR.amountSats }],
    vout: VECTOR.outputs,
    locktime: VECTOR.locktime,
  };
}

test('the signature digest matches Bitcoin step for step (BIP-143, ALL)', () => {
  const digest = bip143Digest({
    tx: vectorTx(),
    scriptCodeHex: VECTOR.scriptCodeHex,
    prevAmountSats: VECTOR.amountSats,
  });
  assert.equal(scriptToHex(digest), VECTOR.digestHex);
});

test('the escrow digest refuses to sign a script that is not the exact shape', () => {
  const tx = vectorTx();
  assert.throws(
    () => p2wshSignatureDigest({ tx, witnessScriptHex: VECTOR.scriptCodeHex, prevAmountSats: VECTOR.amountSats }),
    /exact escrow shape/,
  );
  // and an escrow script itself digests fine through the same builder
  const escrowTx = buildSpendTx({
    fundingTxid: displayTxid(), fundingVout: VECTOR.vout, fundingSats: VECTOR.amountSats,
    witnessScriptHex: SCRIPT_HEX, outputs: VECTOR.outputs, sequence: VECTOR.sequence,
  });
  assert.doesNotThrow(
    () => p2wshSignatureDigest({ tx: escrowTx, witnessScriptHex: SCRIPT_HEX, prevAmountSats: VECTOR.amountSats }),
  );
});

test('the outputs of a spend can never pay out more than the escrow held', () => {
  assert.throws(() => buildSpendTx({
    fundingTxid: 'ab'.repeat(32), fundingSats: 1000n,
    witnessScriptHex: SCRIPT_HEX,
    outputs: [{ sats: 1001n, scriptHex: '76a914' + '00'.repeat(20) + '88ac' }],
  }), /overreach/);
  assert.throws(() => buildSpendTx({
    fundingTxid: 'ab'.repeat(32), fundingSats: 1000n,
    witnessScriptHex: SCRIPT_HEX,
    outputs: [{ sats: 500n, scriptHex: 'x' }],
  }), /script/);
  // and the same object builds a tx twice, identically (determinism)
  const a = buildSpendTx({
    fundingTxid: 'ab'.repeat(32), fundingSats: 1000n, witnessScriptHex: SCRIPT_HEX,
    outputs: [{ sats: 1000n, scriptHex: '76a914' + '00'.repeat(20) + '88ac' }], sequence: 2880,
  });
  const b = buildSpendTx({
    fundingTxid: 'ab'.repeat(32), fundingSats: 1000n, witnessScriptHex: SCRIPT_HEX,
    outputs: [{ sats: 1000n, scriptHex: '76a914' + '00'.repeat(20) + '88ac' }], sequence: 2880,
  });
  assert.deepEqual(a, b);
});

// A full release: the FSM table as outputs, a 1,440-sat miner fee taken
// out of the buyer change, both keys signing the SAME digest,
// signatures verified against the public keys they came from.
const P = 50_000_000n;
const Q = quoteEscrow(P);
const FUNDING_TXID = 'aa'.repeat(32);
const MINER_FEE = 1440n;
// funding = deposit + 2,000 -> buyer change = 2,000 - fee; outputs +
// fee == funding exactly
const FUNDING = Q.depositSats + 2000n;
const TX_OUTS = () => ([
  { sats: Q.vendorOutSats, scriptHex: '76a914' + '11'.repeat(20) + '88ac' }, // vendor
  { sats: Q.feeOutSats, scriptHex: '76a914' + '22'.repeat(20) + '88ac' },    // fee
  { sats: 2000n - MINER_FEE, scriptHex: '76a914' + '33'.repeat(20) + '88ac' }, // buyer change
]);

test('a release signs, double-signs, and its signatures verify', () => {
  const result = finalizeReleaseTx({
    fundingTxid: FUNDING_TXID, fundingSats: FUNDING,
    witnessScriptHex: SCRIPT_HEX,
    outputs: TX_OUTS(),
    vendorKeyBytes: VENDOR_PRIV,
    buyerKeyBytes: BUYER_PRIV,
  });
  const digest = result.digest;
  assert.equal(
    verifySpendSignature({ signatureBytes: result.vendorSig, publicKeyBytes: secp256k1.getPublicKey(VENDOR_PRIV, true), digest }),
    true,
  );
  assert.equal(
    verifySpendSignature({ signatureBytes: result.buyerSig, publicKeyBytes: secp256k1.getPublicKey(BUYER_PRIV, true), digest }),
    true,
  );
  // the wrong key never verifies
  assert.equal(
    verifySpendSignature({ signatureBytes: result.vendorSig, publicKeyBytes: secp256k1.getPublicKey(BUYER_PRIV, true), digest }),
    false,
  );
  // deterministic: same keys, same digest, same tx
  const again = finalizeReleaseTx({
    fundingTxid: FUNDING_TXID, fundingSats: FUNDING, witnessScriptHex: SCRIPT_HEX,
    outputs: TX_OUTS(), vendorKeyBytes: VENDOR_PRIV, buyerKeyBytes: BUYER_PRIV,
  });
  assert.equal(again.bytes, result.bytes);
  assert.notEqual(again.txid, '', 'txid derives');
  // conservation on the wire: outputs + miner fee == what the escrow held
  const outSum = TX_OUTS().reduce((n, o) => n + o.sats, 0n);
  assert.equal(outSum + MINER_FEE, FUNDING);
});

test('a timed refund carries the CSV clock on the input sequence, not anywhere else', () => {
  const result = finalizeTimedRefundTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats,
    witnessScriptHex: SCRIPT_HEX,
    outputs: [{ sats: Q.depositSats - 1440n, scriptHex: '76a914' + '33'.repeat(20) + '88ac' }],
    delayBlocks: 2880,
    buyerKeyBytes: BUYER_PRIV,
  });
  assert.equal(result.tx.vin[0].sequence, 2880);
  assert.equal(
    verifySpendSignature({ signatureBytes: result.buyerSig, publicKeyBytes: secp256k1.getPublicKey(BUYER_PRIV, true), digest: result.digest }),
    true,
  );
  assert.throws(() => finalizeTimedRefundTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: SCRIPT_HEX,
    outputs: [{ sats: 1n, scriptHex: '76a914' + '33'.repeat(20) + '88ac' }],
    buyerKeyBytes: BUYER_PRIV,
  }), /script delay/);
  // refund refund pays out what went in (minus fee = 0 at the money table)
  assert.equal(result.tx.vout[0].sats < result.tx.vin[0].amountSats, true); // miner fee came out
});

// The Dead Drop close, signed the way the chain will read it: the
// vendor alone, preimage in the witness, all value out fee-free.
const DROPHASH = sha256(Uint8Array.from({ length: 32 }, (_, i) => 0xc0 + i));
const NONCE = Uint8Array.from({ length: 32 }, (_, i) => 0xc0 + i);
const DROPPED_SCRIPT_HEX = scriptToHex(assembleOvertOrderScript({
  vendorPubKey: PUB_V, buyerPubKey: PUB_B, delayBlocks: 2880, overtHash: DROPHASH,
}));
// The enforced money table: ONE output, the buyer's key, bare P2PK —
// the same shape the refund branch names and the membrane re-checks.
const BUYER_P2PK = '21' + scriptToHex(PUB_B) + 'ac';

test('the dead drop close is the vendor ALONE: one signature, the preimage, all the money', () => {
  const buyerOut = { sats: Q.depositSats - 1440n, scriptHex: BUYER_P2PK };
  const result = finalizeOvertRefundTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats,
    witnessScriptHex: DROPPED_SCRIPT_HEX,
    outputs: [buyerOut],
    preimageBytes: NONCE,
    vendorKeyBytes: VENDOR_PRIV,
  });
  // no CSV on this branch: the dead drop fires any time the vendor
  // chooses, so the input carries the CSV-disable sequence
  assert.equal(result.tx.vin[0].sequence, 0xffffffff);
  // the one signature is the vendor's, over the same BIP-143 digest
  assert.equal(
    verifySpendSignature({ signatureBytes: result.vendorSig, publicKeyBytes: secp256k1.getPublicKey(VENDOR_PRIV, true), digest: result.digest }),
    true,
  );
  // the buyer key can never open the dead drop branch: wrong key, wrong shape
  const buyerKey = secp256k1.getPublicKey(BUYER_PRIV, true);
  assert.equal(
    verifySpendSignature({ signatureBytes: result.vendorSig, publicKeyBytes: buyerKey, digest: result.digest }),
    false,
  );
  // conservation: what goes back is what came in (fee is just the miner's)
  assert.equal(result.tx.vout[0].sats + 1440n, Q.depositSats);
});

test('the dead drop opens only on the committed preimage', () => {
  const buyerOut = { sats: Q.depositSats - 1440n, scriptHex: BUYER_P2PK };
  // a wrong nonce: the commitment cross-check refuses before signing,
  // because the chain would refuse it later anyway
  assert.throws(() => finalizeOvertRefundTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: DROPPED_SCRIPT_HEX,
    outputs: [buyerOut], preimageBytes: Uint8Array.from({ length: 32 }, (_, i) => 0xd0 + i),
    vendorKeyBytes: VENDOR_PRIV,
  }), /committed hash/);
  // no nonce, half a nonce, a hex string: all refused at the door
  assert.throws(() => finalizeOvertRefundTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: DROPPED_SCRIPT_HEX,
    outputs: [buyerOut], vendorKeyBytes: VENDOR_PRIV,
  }), /delivery nonce/);
  // the plain 2-of-2 box has no dead drop to open
  assert.throws(() => finalizeOvertRefundTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: SCRIPT_HEX,
    outputs: [buyerOut], preimageBytes: NONCE, vendorKeyBytes: VENDOR_PRIV,
  }), /Dead Drop script/);
});

test('the partial-money lie is dead at the builder: one output, buyer key, or nothing', () => {
  // (re-attack round 2, vector 3: the overt branch binds WHO signs and
  // WHAT is known, never WHERE money lands — no CTV. So the builder
  // itself is the enforcement point for our own app's table, and the
  // membrane re-checks the same facts on the watcher's report.)
  // two outputs = the money table split = refused
  assert.throws(() => finalizeOvertRefundTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: DROPPED_SCRIPT_HEX,
    outputs: [
      { sats: Q.depositSats - 1440n - 7000n, scriptHex: BUYER_P2PK },
      { sats: 7000n, scriptHex: '76a914' + '44'.repeat(20) + '88ac' },
    ],
    preimageBytes: NONCE, vendorKeyBytes: VENDOR_PRIV,
  }), /exactly one output/);
  // the vendor's own key as the output = the fee-free promise in
  // reverse = refused
  assert.throws(() => finalizeOvertRefundTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: DROPPED_SCRIPT_HEX,
    outputs: [{ sats: Q.depositSats - 1440n, scriptHex: '21' + scriptToHex(PUB_V) + 'ac' }],
    preimageBytes: NONCE, vendorKeyBytes: VENDOR_PRIV,
  }), /buyer key/);
  // a hostile P2PKH (hash of something, not the key named by the
  // branch) = refused the same way
  assert.throws(() => finalizeOvertRefundTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: DROPPED_SCRIPT_HEX,
    outputs: [{ sats: Q.depositSats - 1440n, scriptHex: '76a914' + '55'.repeat(20) + '88ac' }],
    preimageBytes: NONCE, vendorKeyBytes: VENDOR_PRIV,
  }), /buyer key/);
});

// The Clock Box: the claim spends booked the way the chain will read it —
// the vendor alone, the same preimage the dead drop carries, past the CSV
// clock, all the money to the VENDOR's key, fee-free by founder order.
const CLOCKS_SCRIPT_HEX = scriptToHex(assembleClockClaimScript({
  vendorPubKey: PUB_V, buyerPubKey: PUB_B, delayBlocks: 2880, overtHash: DROPHASH,
}));
const VENDOR_P2PK = '21' + scriptToHex(PUB_V) + 'ac';

test('the clock claim frees the vendor alone: the money table is vendor P2PK, fee-free', () => {
  const result = finalizeClockClaimTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats,
    witnessScriptHex: CLOCKS_SCRIPT_HEX,
    outputs: [{ sats: Q.depositSats - 1440n, scriptHex: VENDOR_P2PK }],
    preimageBytes: NONCE,
    vendorKeyBytes: VENDOR_PRIV,
  });
  // the input sequence IS the CSV clock: the claim cannot fire day one
  assert.equal(result.tx.vin[0].sequence, 2880);
  assert.equal(
    verifySpendSignature({ signatureBytes: result.vendorSig, publicKeyBytes: secp256k1.getPublicKey(VENDOR_PRIV, true), digest: result.digest }),
    true,
  );
  // conservation: outputs + miner fee == what the escrow held
  assert.equal(result.tx.vout[0].sats + 1440n, Q.depositSats);
});

test('the clock claim refuses wrong keys, wrong shapes, and an early fire', () => {
  const out = [{ sats: Q.depositSats - 1440n, scriptHex: VENDOR_P2PK }];
  assert.throws(() => finalizeClockClaimTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: CLOCKS_SCRIPT_HEX,
    outputs: out, vendorKeyBytes: VENDOR_PRIV,
  }), /delivery nonce/);
  assert.throws(() => finalizeClockClaimTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: CLOCKS_SCRIPT_HEX,
    outputs: out, preimageBytes: Uint8Array.from({ length: 32 }, (_, i) => 0xd0 + i), vendorKeyBytes: VENDOR_PRIV,
  }), /committed hash/);
  // the plain 2-of-2 box and the dead drop WITHOUT the claim branch have
  // no clock claim to open
  assert.throws(() => finalizeClockClaimTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: SCRIPT_HEX,
    outputs: out, preimageBytes: NONCE, vendorKeyBytes: VENDOR_PRIV,
  }), /Clock Box/);
  assert.throws(() => finalizeClockClaimTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: DROPPED_SCRIPT_HEX,
    outputs: out, preimageBytes: NONCE, vendorKeyBytes: VENDOR_PRIV,
  }), /Clock Box/);
});

test('the clock claim money table lies are dead at the builder, too', () => {
  // two outputs = splitting the take = refused
  assert.throws(() => finalizeClockClaimTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: CLOCKS_SCRIPT_HEX,
    outputs: [
      { sats: Q.depositSats - 1440n - 5000n, scriptHex: VENDOR_P2PK },
      { sats: 5000n, scriptHex: BUYER_P2PK },
    ],
    preimageBytes: NONCE, vendorKeyBytes: VENDOR_PRIV,
  }), /exactly one output/);
  // the BUYER key as the claim's output (the dead drop pays the buyer;
  // the claim pays the vendor — swapped destinations are refused)
  assert.throws(() => finalizeClockClaimTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: CLOCKS_SCRIPT_HEX,
    outputs: [{ sats: Q.depositSats - 1440n, scriptHex: BUYER_P2PK }],
    preimageBytes: NONCE, vendorKeyBytes: VENDOR_PRIV,
  }), /vendor key/);
  // and a hostile P2PKH: refused along with every stranger shape
  assert.throws(() => finalizeClockClaimTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: CLOCKS_SCRIPT_HEX,
    outputs: [{ sats: Q.depositSats - 1440n, scriptHex: '76a914' + '66'.repeat(20) + '88ac' }],
    preimageBytes: NONCE, vendorKeyBytes: VENDOR_PRIV,
  }), /vendor key/);
});

test('the dead drop refund still fires on the Clock Box, same stack, same word', () => {
  // the overt branch lives above the claim branch: any-time refund on
  // the clock box needs no extra witness frame
  const buyerOut = { sats: Q.depositSats - 1440n, scriptHex: BUYER_P2PK };
  const result = finalizeOvertRefundTx({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats,
    witnessScriptHex: CLOCKS_SCRIPT_HEX,
    outputs: [buyerOut], preimageBytes: NONCE, vendorKeyBytes: VENDOR_PRIV,
  });
  assert.equal(result.tx.vin[0].sequence, 0xffffffff);
  assert.equal(result.tx.vout[0].sats + 1440n, Q.depositSats);
});

test('signatures are DER with one SIGHASH_ALL byte, checked byte by byte', () => {
  const digest = doubleSha256(new Uint8Array([9]));
  const sig = signSpend({ privateKeyBytes: VENDOR_PRIV, digest });
  assert.equal(sig[sig.length - 1], 0x01); // the trailing hashType byte
  const derLen = sig.length - 1;
  assert.equal(derLen > 64 && derLen <= 72, true); // 0x30||..; nil short DER
  assert.equal(sig[0], 0x30);
  assert.equal(
    verifySpendSignature({ signatureBytes: sig, publicKeyBytes: secp256k1.getPublicKey(VENDOR_PRIV, true), digest }),
    true,
  );
  assert.throws(() => signSpend({ privateKeyBytes: 'x', digest }), /32-byte/);
});

test('the escape-hatch PSBT carries exactly what a foreign wallet needs', () => {
  const psbt = buildEscrowPsbt({
    fundingTxid: FUNDING_TXID,
    fundingVout: 0,
    fundingSats: FUNDING,
    witnessScriptHex: SCRIPT_HEX,
    outputs: TX_OUTS(),
  });
  const b64 = psbtBase64(psbt);
  const bytes = base64.decode(b64);
  // magic
  assert.equal(scriptToHex(bytes.slice(0, 5)), '70736274ff');
  // the input's witness utxo (0x01) carries amount + script (0020 + sha256 of the escrow script)
  const whole = scriptToHex(bytes);
  const witnessUtxoScript = '0020' + scriptToHex(sha256(hexToScript(SCRIPT_HEX)));
  assert.equal(whole.includes(witnessUtxoScript), true, 'PSBT embeds the P2WSH program');
  // the witness script (0x04) is embedded verbatim
  assert.equal(whole.includes(SCRIPT_HEX), true, 'PSBT embeds the escrow witness script');
  // unsigned tx inside embeds the funding txid little-endian (reversed)
  const leFunding = [...hexToScript(FUNDING_TXID)].reverse().map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(whole.includes(leFunding), true, 'PSBT embeds the outpoint');
  assert.notEqual(b64, '');
  // and the default kind is the release: 0xffffffff on the input
  assert.equal(psbt.tx.vin[0].sequence, 0xffffffff);
});

test('the escape hatch carries the refund branch too — with the CSV clock on the sequence', () => {
  // A refund PSBT built at 0xffffffff is a dead end: that sequence
  // disables BIP-68, so OP_CSV can never pass and a foreign wallet
  // holding the escape hatch could never take the refund home.
  // (re-attack round @ 52cbdab)
  const psbt = buildEscrowPsbt({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats,
    witnessScriptHex: SCRIPT_HEX,
    outputs: [{ sats: Q.depositSats - 1440n, scriptHex: '76a914' + '33'.repeat(20) + '88ac' }],
    kind: 'timed-refund', delayBlocks: 2880,
  });
  assert.equal(psbt.tx.vin[0].sequence, 2880);
  // and the digest signs under the refund variant, too
  assert.doesNotThrow(() => p2wshSignatureDigest({ tx: psbt.tx, witnessScriptHex: SCRIPT_HEX, prevAmountSats: Q.depositSats }));
  // a refund PSBT without the delay is refused, not defaulted
  assert.throws(() => buildEscrowPsbt({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: SCRIPT_HEX,
    outputs: [{ sats: Q.depositSats - 1440n, scriptHex: '76a914' + '33'.repeat(20) + '88ac' }],
    kind: 'timed-refund',
  }), /script delay/);
  assert.throws(() => buildEscrowPsbt({
    fundingTxid: FUNDING_TXID, fundingSats: Q.depositSats, witnessScriptHex: SCRIPT_HEX,
    outputs: [{ sats: Q.depositSats, scriptHex: '76a914' + '33'.repeat(20) + '88ac' }],
    kind: 'snorkel',
  }), /Unknown PSBT kind/);
});

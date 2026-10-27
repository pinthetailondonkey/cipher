// The escrow purchase script (docs/ESCROW.md), assembled and decoded in
// raw bytes. No dependency at this layer: Bitcoin script is plain bytes,
// and every byte here is constant across wallets and eras.
//
//   OP_IF <vendor_pub> OP_CHECKSIGVERIFY <buyer_pub> OP_CHECKSIG
//   OP_ELSE <delay> OP_CSV OP_DROP <buyer_pub> OP_CHECKSIG
//   OP_ENDIF
//
// The absence of any other branch is the product: there is no arbiter
// key, no recovery key, no support backdoor. Both readers of this file
// — the app and a skeptical outsider — must assemble the same bytes,
// so decode is exact: three shapes, strict pushes, nothing optional.
//
// Shape 1, the plain box:
//
//   OP_IF    <vendor_pub> OP_CHECKSIGVERIFY <buyer_pub> OP_CHECKSIG
//   OP_ELSE  <delay> OP_CSV OP_DROP <buyer_pub> OP_CHECKSIG
//   OP_ENDIF
//
// Shape 2, the Dead Drop box: the same release branch, and the refund
// side gains one nested overt branch the VENDOR fires alone.
//
//   OP_IF    <vendor_pub> OP_CHECKSIGVERIFY <buyer_pub> OP_CHECKSIG
//   OP_ELSE  OP_IF      OP_SHA256 <overt_hash> OP_EQUALVERIFY <vendor_pub> OP_CHECKSIG
//            OP_ELSE    <delay> OP_CSV OP_DROP <buyer_pub> OP_CHECKSIG
//            OP_ENDIF
//   OP_ENDIF
//
// Shape 3, the Clock Box (see assembleClockClaimScript): the Dead Drop
// box with the day-20 claim branch under the same CSV gate.
//
// The vendor returns ALL the money to the buyer fee-free, any time —
// but only by publishing preimage(overt_hash) on-chain: the act of
// handing the money back is a chain-anchored delivery attestation.
// (The hash is fixed before funding, so it cannot be minted after.)
// What it proves is the honesty limit, everywhere this ships: the
// vendor ASSERTED delivery. It does not prove atoms moved. Where the
// money goes (ALL to the buyer, fee-free) is the spend's output set,
// not script bytes — the callers build that output, the wire tests pin
// it, and no CTV means no script can force the destination.

const OP_IF = 0x63;
const OP_ELSE = 0x67;
const OP_ENDIF = 0x68;
const OP_DROP = 0x75;
const OP_CHECKSIG = 0xac;
const OP_CHECKSIGVERIFY = 0xad;
const OP_CSV = 0xb2;
const OP_SHA256 = 0xa8;
const OP_EQUALVERIFY = 0x88;

const COMPRESSED_PUBKEY = 33; // Bitcoin compressed secp256k1 point

// 16-bit relative-locktime ceiling in blocks — the refund timer's legal
// range on the chain.
export const MAX_CSV_BLOCK_DELAY = 65535;
export const MIN_CSV_BLOCK_DELAY = 1;

function pushBytes(bytes) {
  const len = bytes.length;
  if (len < 1 || len > 75) throw new Error('Escrow keys and delays push in one small chunk.');
  return [len, ...bytes];
}

// Minimal script-number push, the way Bitcoin itself reads it: signless
// little-endian bytes (value <= 0x7fff hits two bytes with the top bit
// clear on the top byte, so no sign-padding is ever needed here).
function scriptNumPush(value) {
  if (!Number.isInteger(value) || value < MIN_CSV_BLOCK_DELAY || value > MAX_CSV_BLOCK_DELAY) {
    throw new Error(`The refund delay must be a block count from ${MIN_CSV_BLOCK_DELAY} to ${MAX_CSV_BLOCK_DELAY}.`);
  }
  const out = [];
  let rest = value;
  while (rest > 0) {
    out.push(rest & 0xff);
    rest >>= 8;
  }
  if (out[out.length - 1] & 0x80) out.push(0x00); // keep the sign positive
  return pushBytes(out);
}

function isPubkey(value) {
  return value instanceof Uint8Array && value.length === COMPRESSED_PUBKEY;
}

function isOvertHash(value) {
  return value instanceof Uint8Array && value.length === 32;
}

// Assemble the order script from per-order derived keys. delayBlocks is
// the chain-enforced refund timer (docs default 20 days = 2880 blocks);
// the app displays days, the chain counts blocks.
export function assembleOrderScript({ vendorPubKey, buyerPubKey, delayBlocks }) {
  if (!isPubkey(vendorPubKey)) throw new Error('The vendor key must be a 33-byte compressed point.');
  if (!isPubkey(buyerPubKey)) throw new Error('The buyer key must be a 33-byte compressed point.');
  return Uint8Array.from([
    OP_IF,
    ...pushBytes(vendorPubKey), OP_CHECKSIGVERIFY,
    ...pushBytes(buyerPubKey), OP_CHECKSIG,
    OP_ELSE,
    ...scriptNumPush(delayBlocks), OP_CSV, OP_DROP,
    ...pushBytes(buyerPubKey), OP_CHECKSIG,
    OP_ENDIF,
  ]);
}

// The Dead Drop box: the plain box plus the nested overt branch. The
// inner branch opens ONLY on a preimage whose SHA-256 is the overt hash
// fixed before funding, then on the vendor key alone — no buyer key, no
// timer. overtHash is SHA-256 of the vendor's delivery nonce, committed
// at escrow_open; only the vendor ever holds the nonce, so only the
// vendor can ever fire this branch.
export function assembleOvertOrderScript({ vendorPubKey, buyerPubKey, delayBlocks, overtHash }) {
  if (!isPubkey(vendorPubKey)) throw new Error('The vendor key must be a 33-byte compressed point.');
  if (!isPubkey(buyerPubKey)) throw new Error('The buyer key must be a 33-byte compressed point.');
  if (!isOvertHash(overtHash)) throw new Error('The overt hash must be a 32-byte SHA-256.');
  return Uint8Array.from([
    OP_IF,
    ...pushBytes(vendorPubKey), OP_CHECKSIGVERIFY,
    ...pushBytes(buyerPubKey), OP_CHECKSIG,
    OP_ELSE,
    OP_IF,
    OP_SHA256,
    ...pushBytes(overtHash), OP_EQUALVERIFY,
    ...pushBytes(vendorPubKey), OP_CHECKSIG,
    OP_ELSE,
    ...scriptNumPush(delayBlocks), OP_CSV, OP_DROP,
    ...pushBytes(buyerPubKey), OP_CHECKSIG,
    OP_ENDIF,
    OP_ENDIF,
  ]);
}

// The Clock Box (founder card, "keep clock claim"): the Dead Drop box
// with one more branch. After the refund timer's CSV gate (the SAME
// day-20 clock), an inner OP_IF opens a second delivery-attested claim:
// the vendor alone, same committed preimage, takes ALL the money home.
// Buyer silence at day 20 never strands the vendor, and the buyer's own
// refund branch sits in the SAME dispatch beside it — whoever needs the
// money uses their branch. The claim's destination is enforced at the
// spend builder and re-checked by the membrane (no CTV), and its fee is
// zero by founder order: the 5% exists only on the cooperative release.
export function assembleClockClaimScript({ vendorPubKey, buyerPubKey, delayBlocks, overtHash }) {
  if (!isPubkey(vendorPubKey)) throw new Error('The vendor key must be a 33-byte compressed point.');
  if (!isPubkey(buyerPubKey)) throw new Error('The buyer key must be a 33-byte compressed point.');
  if (!isOvertHash(overtHash)) throw new Error('The overt hash must be a 32-byte SHA-256.');
  return Uint8Array.from([
    OP_IF,
    ...pushBytes(vendorPubKey), OP_CHECKSIGVERIFY,
    ...pushBytes(buyerPubKey), OP_CHECKSIG,
    OP_ELSE,
    OP_IF,
    OP_SHA256,
    ...pushBytes(overtHash), OP_EQUALVERIFY,
    ...pushBytes(vendorPubKey), OP_CHECKSIG,
    OP_ELSE,
    ...scriptNumPush(delayBlocks), OP_CSV, OP_DROP,
    OP_IF,
    OP_SHA256,
    ...pushBytes(overtHash), OP_EQUALVERIFY, // the SAME commitment: one nonce, one delivery word
    ...pushBytes(vendorPubKey), OP_CHECKSIG,
    OP_ELSE,
    ...pushBytes(buyerPubKey), OP_CHECKSIG,
    OP_ENDIF,
    OP_ENDIF,
    OP_ENDIF,
  ]);
}

export function hexToScript(hex) {
  const clean = String(hex ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('The script is not even hex.');
  }
  return Uint8Array.from((clean.match(/../g) || []).map((pair) => parseInt(pair, 16)));
}

export function scriptToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Decode is strict: the exact shape, nothing else. A script that is not
// byte-for-byte the escrow shape is a foreign object, never adopted —
// the order card and the membrane both treat it the way they treat a
// failed digest.
export function decodeOrderScript(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  let i = 0;
  const readByte = () => bytes[i++];
  const readPush = () => {
    const len = readByte();
    if (len < 1 || len > 75) return null;
    if (i + len > bytes.length) return null;
    const out = bytes.slice(i, i + len);
    i += len;
    return out;
  };
  // The delay decodes the way the chain reads script numbers: unsigned
  // little-endian, minimal. Minimal means no padding — except Bitcoin's
  // own positive-sign byte: a trailing 0x00 is legal ONLY when the byte
  // before it carries the high bit (0xFFFF therefore encodes as ff ff 00).
  const readNum = () => {
    const pushed = readPush();
    if (!pushed || pushed.length === 0 || pushed.length > 4) return null;
    const top = pushed[pushed.length - 1];
    if (top === 0x00 && pushed.length > 1 && !(pushed[pushed.length - 2] & 0x80)) return null;
    let value = 0;
    for (let k = 0; k < pushed.length; k += 1) value += pushed[k] * 2 ** (8 * k);
    return value < MIN_CSV_BLOCK_DELAY || value > MAX_CSV_BLOCK_DELAY ? null : value;
  };

  try {
    if (readByte() !== OP_IF) return null;
    const vendorPubKey = readPush();
    if (!isPubkey(vendorPubKey) || readByte() !== OP_CHECKSIGVERIFY) return null;
    const buyerPubKey = readPush();
    if (!isPubkey(buyerPubKey) || readByte() !== OP_CHECKSIG) return null;
    if (readByte() !== OP_ELSE) return null;
    // After the outer OP_ELSE, the plain box's next byte is the delay
    // push's length byte (1..4); the Dead Drop box opens OP_IF (0x63),
    // which is never a legal delay push length — one unambiguous byte.
    let overtHash = null;
    let claimBlocks = null;
    if (readByte() === OP_IF) {
      // Dead Drop branch: OP_SHA256 <32-byte hash> OP_EQUALVERIFY <vendor_pub> OP_CHECKSIG
      if (readByte() !== OP_SHA256) return null;
      overtHash = readPush();
      if (!isOvertHash(overtHash) || readByte() !== OP_EQUALVERIFY) return null;
      const overtVendor = readPush();
      if (!isPubkey(overtVendor) || readByte() !== OP_CHECKSIG) return null;
      // the overt unlock is the VENDOR's key — the same one the release
      // branch verifies; a stranger fires nobody's dead drop
      if (scriptToHex(overtVendor) !== scriptToHex(vendorPubKey)) return null;
      if (readByte() !== OP_ELSE) return null;
    } else {
      i -= 1; // plain box: step back onto the delay push's length byte
    }
    const delay = readNum();
    if (delay === null || readByte() !== OP_CSV || readByte() !== OP_DROP) return null;
    let refundBuyer;
    if (overtHash !== null && bytes[i] === OP_IF) {
      // The Clock Box (third shape): the delay's CSV gates both remaining
      // branches. The claim side: the SAME committed preimage, the VENDOR's
      // key — one nonce, one delivery word for both attested exits.
      i += 1;
      if (readByte() !== OP_SHA256) return null;
      const claimHash = readPush();
      if (!isOvertHash(claimHash) || readByte() !== OP_EQUALVERIFY) return null;
      // one commitment, one nonce: a second clock unlocked by ANY other
      // preimage is a second delivery word minted from nothing
      if (scriptToHex(claimHash) !== scriptToHex(overtHash)) return null;
      const claimVendor = readPush();
      if (!isPubkey(claimVendor) || readByte() !== OP_CHECKSIG) return null;
      if (scriptToHex(claimVendor) !== scriptToHex(vendorPubKey)) return null;
      if (readByte() !== OP_ELSE) return null;
      const claimBuyer = readPush();
      if (!isPubkey(claimBuyer) || readByte() !== OP_CHECKSIG) return null;
      if (scriptToHex(claimBuyer) !== scriptToHex(buyerPubKey)) return null;
      if (readByte() !== OP_ENDIF) return null;
      refundBuyer = claimBuyer;
      claimBlocks = delay;
    } else {
      refundBuyer = readPush();
      if (!isPubkey(refundBuyer) || readByte() !== OP_CHECKSIG) return null;
    }
    if (readByte() !== OP_ENDIF) return null;
    // the Dead Drop box nests one frame deeper: a second OP_ENDIF
    // closes the outer refund side. The plain box has exactly one frame.
    if (overtHash !== null && readByte() !== OP_ENDIF) return null;
    if (i !== bytes.length) return null;
    // the refund branch pays the buyer — the same buyer the release
    // branch verifies; a stranger's key in the refund branch never assembles.
    if (scriptToHex(refundBuyer) !== scriptToHex(buyerPubKey)) return null;
    // and the two slot keys are not equal: one signature would then pass
    // both CHECKSIGs and the 2-of-2 would silently close as 1-of-1.
    // (re-attack round @ 52cbdab — unreachable through the vault's
    // derivation, but the strict shape is the contract, so it is the
    // shape that refuses it.)
    if (scriptToHex(vendorPubKey) === scriptToHex(buyerPubKey)) return null;
    return { vendorPubKey, buyerPubKey, delayBlocks: delay, claimBlocks, overtHash };
  } catch {
    return null;
  }
}

// The nSequence an input must carry for the CSV refund branch to be
// spendable: the input's own sequence value is the relative clock the
// script reads. Setting it below the delay keeps the refund branch
// locked; at/after the delay, funding with this sequence enables it.
export const CSV_NSEQUENCE = (delayBlocks) => delayBlocks;

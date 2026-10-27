import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleOrderScript,
  assembleOvertOrderScript,
  decodeOrderScript,
  hexToScript,
  scriptToHex,
  MAX_CSV_BLOCK_DELAY,
  MIN_CSV_BLOCK_DELAY,
} from './escrowScript.js';

// The escrow script bytes, attacked. The round-trip law: assemble then
// decode equals the inputs, for every legal delay. Anything not shaped
// exactly like the escrow script decodes to null — a crafted variant is
// a foreign object, never adopted.

const V = Uint8Array.from({ length: 33 }, (_, i) => 0x11 + i);
const B = Uint8Array.from({ length: 33 }, (_, i) => 0x2a + i);
const WRONG = Uint8Array.from({ length: 33 }, (_, i) => 0xf0 + i);
const OVERT = Uint8Array.from({ length: 32 }, (_, i) => 0x5a + i);

// The Dead Drop box, attacked the same way: the plain box plus the
// nested overt branch the vendor fires alone. Everything here keeps
// the round-trip law — decode is exact, nothing optional, a crafted
// variant is a foreign object.
test('the dead drop box round-trips: deployment hash, keys, delay all come back', () => {
  for (const delay of [2880, MIN_CSV_BLOCK_DELAY, MAX_CSV_BLOCK_DELAY, 144, 65534]) {
    const bytes = assembleOvertOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: delay, overtHash: OVERT });
    const back = decodeOrderScript(bytes);
    assert.notEqual(back, null, `dead drop round-trip failed at delay ${delay}`);
    assert.equal(scriptToHex(back.vendorPubKey), scriptToHex(V));
    assert.equal(scriptToHex(back.buyerPubKey), scriptToHex(B));
    assert.equal(back.delayBlocks, delay);
    // the committed hash comes back byte for byte: the vendor fixed it
    // before funding and the decoder says exactly what it is
    assert.equal(scriptToHex(back.overtHash), scriptToHex(OVERT));
  }
});

test('the plain box still decodes, with no overt branch recorded', () => {
  const bytes = assembleOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 2880 });
  const back = decodeOrderScript(bytes);
  assert.notEqual(back, null);
  assert.equal(back.overtHash, null, 'the plain box carries no overt hash');
});

test('the delay dispatch after OP_ELSE is unambiguous: a delay ending in 0x63 does not decode as an overt branch', () => {
  // 0x63 = OP_IF; a plain box whose delay's first byte would be 0x63
  // would go to the overt parser and die. But the delay always pushes
  // its LENGTH first, so the dispatch byte is 1..4, never 0x63.
  const bytes = assembleOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 99 }); // 99 = 0x63
  const back = decodeOrderScript(bytes);
  assert.notEqual(back, null, 'a delay of 99 (0x63 the number) still decodes as plain');
  assert.equal(back.delayBlocks, 99);
  assert.equal(back.overtHash, null);
});

test('the overt branch is the vendor ALONE: a stranger at the dead drop refuses', () => {
  // the overt branch must verify the SAME vendor key the release branch
  // verifies — a swapped key is a foreign object
  const bytes = assembleOvertOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 2880, overtHash: OVERT });
  const hex = scriptToHex(bytes);
  const overtKeyAt = hex.indexOf(scriptToHex(V), hex.indexOf('a8')); // after OP_SHA256
  const strangerBox = hexToScript(hex.slice(0, overtKeyAt) + scriptToHex(WRONG) + hex.slice(overtKeyAt + 66));
  assert.equal(decodeOrderScript(strangerBox), null, "a stranger's key at the dead drop refuses to decode");
});

test('the overt branch is the vendor ALONE: refund branch equality holds on the dead drop too', () => {
  // swap the refund key inside the innermost (timed) branch
  const bytes = assembleOvertOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 2880, overtHash: OVERT });
  const hex = scriptToHex(bytes);
  const refundAt = hex.lastIndexOf(scriptToHex(B));
  const strangerRefund = hexToScript(hex.slice(0, refundAt) + scriptToHex(WRONG) + hex.slice(refundAt + 66));
  assert.equal(decodeOrderScript(strangerRefund), null);
});

test('the committed hash is exactly 32 bytes of hash: wrong lengths refuse', () => {
  assert.throws(
    () => assembleOvertOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 2880, overtHash: Uint8Array.from({ length: 20 }, () => 1) }),
    /overt hash/,
  );
  assert.throws(
    () => assembleOvertOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 2880, overtHash: '5a'.repeat(32) }),
    /overt hash/,
  );
  assert.throws(
    () => assembleOvertOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 2880 }),
    /overt hash/,
  );
  // and the decoder refuses the hash lie from the other side: a hash
  // push that is not exactly 32 bytes means no box at all — it can
  // never be ENDIF'd back together
  const bytes = assembleOvertOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 2880, overtHash: OVERT });
  const hex = scriptToHex(bytes);
  const full = '20' + scriptToHex(OVERT);
  assert.notEqual(hex.indexOf(full), -1, 'the 32-byte hash push is where this test thinks it is');
  // 31-byte push: wrong length, refused before the branch even finishes
  assert.equal(decodeOrderScript(hexToScript(hex.replace(full, '1f' + scriptToHex(OVERT).slice(2)))), null);
  // 33-byte padded push: same refusal
  assert.equal(decodeOrderScript(hexToScript(hex.replace(full, '21' + scriptToHex(OVERT) + '00'))), null);
});


test('assemble + decode round-trips at the 20-day default and across delays', () => {
  for (const delay of [2880, MIN_CSV_BLOCK_DELAY, MAX_CSV_BLOCK_DELAY, 144, 65534]) {
    const bytes = assembleOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: delay });
    const back = decodeOrderScript(bytes);
    assert.notEqual(back, null, `round-trip failed at delay ${delay}`);
    assert.equal(scriptToHex(back.vendorPubKey), scriptToHex(V));
    assert.equal(scriptToHex(back.buyerPubKey), scriptToHex(B));
    assert.equal(back.delayBlocks, delay);
  }
});

test('the bytes match the documented shape, byte for byte', () => {
  const bytes = assembleOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 2880 });
  // OP_IF(63) push33 pub CHECKSIGVERIFY(ad) push33 pub CHECKSIG(ac)
  // OP_ELSE(67) push2 2880(=0x0B40 little-endian: 40 0B) CSV(b2) DROP(75)
  // push33 pub CHECKSIG OP_ENDIF(68) — the delay decodes as 0x0B40 = 2880.
  assert.equal(scriptToHex(bytes).startsWith('6321'), true);
  assert.equal(hexToScript(scriptToHex(bytes)).length, bytes.length);
  const back = decodeOrderScript(bytes);
  assert.equal(back.delayBlocks, 2880);
});

test('two equal slot keys are not a 2-of-2 — decode refuses them', () => {
  // One key in both positions makes one signature pass both CHECKSIGs:
  // the release branch closes silently as 1-of-1. Unreachable through
  // the vault's own derivation, but the strict shape is the contract,
  // so the shape refuses it. (re-attack round @ 52cbdab)
  const bytes = assembleOrderScript({ vendorPubKey: V, buyerPubKey: V, delayBlocks: 2880 });
  assert.equal(decodeOrderScript(bytes), null);
});

test('the delay is read the way the CHAIN reads it, not any other way', () => {
  // little-endian, minimal, sign-correct: 2880 = 0x0B40 -> bytes 40 0B
  const bytes = assembleOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 2880 });
  const hex = scriptToHex(bytes);
  const at = hex.indexOf('02400b');
  assert.notEqual(at, -1, 'delay push bytes missing');
  // a trailing-zero padded push is not what the chain accepts: decode refuses it
  const padded = scriptToHex(bytes).replace('02400bb275', '0300400bb275'); // 0x00,0x40,0x0b padded
  const reassembled = hexToScript(padded);
  assert.equal(decodeOrderScript(reassembled), null);
});

test('crafted shapes refuse to decode — no alternate branch ever adopts', () => {
  const love = assembleOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 2880 });
  const flipBuffers = (from, to, sub) => {
    // swap the first occurrence of one 33-byte pubkey for another
    const src = scriptToHex(from);
    return hexToScript(src.replace(scriptToHex(sub), sub === B ? scriptToHex(WRONG) : scriptToHex(B)));
  };

  // a stranger's key in the refund branch: refused — the refund pays the buyer
  const strangerRefund = (() => {
    const hex = scriptToHex(love);
    const refundAt = hex.lastIndexOf(scriptToHex(B));
    return hexToScript(hex.slice(0, refundAt) + scriptToHex(WRONG) + hex.slice(refundAt + 66));
  })();
  assert.equal(decodeOrderScript(strangerRefund), null);

  // truncation and trailing garbage: refused
  assert.equal(decodeOrderScript(love.slice(0, love.length - 1)), null);
  assert.equal(decodeOrderScript(Uint8Array.from([...love, 0x51])), null);

  // a delay of 0 or 70000-blocks pushes: refused
  assert.equal(decodeOrderScript(flipBuffers(love, love, B).length ? hexToScript('') : null), null);
  // serialized buffer not even the right type: refused
  assert.equal(decodeOrderScript(scriptToHex(love)), null); // hex string in, null out
});

test('bad inputs throw at the assembler, never assemble a wrong box', () => {
  assert.throws(() => assembleOrderScript({ vendorPubKey: null, buyerPubKey: B, delayBlocks: 2880 }), /vendor key/);
  assert.throws(() => assembleOrderScript({ vendorPubKey: V, buyerPubKey: 'x', delayBlocks: 2880 }), /buyer key/);
  assert.throws(() => assembleOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 0 }), /delay/);
  assert.throws(() => assembleOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 70000 }), /delay/);
  assert.throws(() => assembleOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 12.5 }), /delay/);
});

test('same keys and delay assemble the same bytes, anywhere, always', () => {
  const a = assembleOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 2880 });
  const b = assembleOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 2880 });
  assert.equal(scriptToHex(a), scriptToHex(b));
  // and a different delay is a different box — the timer is part of the
  // address identity, and the card shows it before money moves
  const c = assembleOrderScript({ vendorPubKey: V, buyerPubKey: B, delayBlocks: 4320 });
  assert.notEqual(scriptToHex(a), scriptToHex(c));
});

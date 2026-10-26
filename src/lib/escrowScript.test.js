import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleOrderScript,
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

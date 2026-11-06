import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RUMOR_PAD_TARGET_BYTES,
  padRumorContent,
  unpadRumorBody,
} from './giftWrap.js';
import { nip59, nip44 } from 'nostr-tools';

const SK_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PK = '22'.repeat(32);

const rumorFor = (content) => nip59.createRumor({
  kind: 4,
  created_at: 1700000000,
  tags: [['p', PK]],
  content,
}, SK_BYTES);

const sealWrapFor = (rumor) => {
  // createSeal also wants byte keys.
  const seal = nip59.createSeal(rumor, SK_BYTES, PK);
  return { seal };
};

test('pad collapses distinct message lengths into one body size', () => {
  const short = JSON.stringify({ type: 'text', message: 'yes' });
  const medium = JSON.stringify({ type: 'text', message: 'see you at eight then, bringing the receipt from Thursday'.repeat(4) });
  const paddedShort = padRumorContent(short);
  const paddedMedium = padRumorContent(medium);
  assert.equal(paddedShort.length, RUMOR_PAD_TARGET_BYTES);
  assert.equal(paddedMedium.length, RUMOR_PAD_TARGET_BYTES);
  // The F6 witness, as wire behavior: two bodies that used to differ by
  // hundreds of bytes now seal to ciphertexts of the same quantized class.
  const s1 = nip44.v2.utils.getConversationKey(SK_BYTES, PK);
  const c1 = nip44.v2.encrypt(paddedShort, s1);
  const c2 = nip44.v2.encrypt(paddedMedium, s1);
  assert.equal(c1.length, c2.length);
});

test('long payloads fall through unpadded rather than truncating', () => {
  const long = JSON.stringify({ type: 'text', message: 'x'.repeat(2000) });
  const out = padRumorContent(long);
  assert.deepEqual(JSON.parse(out), JSON.parse(long)); // unchanged content
});

test('padding never applies twice and round-trips through unpad', () => {
  const once = padRumorContent(JSON.stringify({ type: 'text', message: 'hi' }));
  const twice = padRumorContent(once);
  assert.equal(twice, once);
  const opened = unpadRumorBody(JSON.parse(once));
  assert.deepEqual(opened, { type: 'text', message: 'hi' });
  void twice;
});

test('non-JSON or non-object content passes through untouched', () => {
  assert.equal(padRumorContent('plain text body'), 'plain text body');
  assert.equal(padRumorContent('[1,2,3]'), '[1,2,3]');
  assert.equal(padRumorContent(undefined), '');
});

test('a padded rumor still seals and reads the original payload', () => {
  const payload = { type: 'text', message: 'the Tuesday plan stands' };
  const shared = nip44.v2.utils.getConversationKey(SK_BYTES, PK);
  const encrypted = nip44.v2.encrypt(padRumorContent(JSON.stringify(payload)), shared);
  const rumor = rumorFor(encrypted);
  const { seal } = sealWrapFor(rumor);
  assert.ok(seal.id);
  const text = nip44.v2.decrypt(rumor.content, shared);
  assert.deepEqual(unpadRumorBody(JSON.parse(text)), payload);
});

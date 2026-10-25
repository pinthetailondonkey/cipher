import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import fs from 'node:fs';
import test from 'node:test';
import { decryptMedia, encryptMedia, isPrivateMedia, openPrivateMedia, uploadPrivateMedia } from './mediaCrypto.js';

const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8])], { type: 'image/jpeg' });

test('an attachment leaves the device as ciphertext and opens only with its key', async () => {
  const { ciphertext, meta } = await encryptMedia(jpeg());
  assert.notDeepEqual([...ciphertext.slice(0, 2)], [0xff, 0xd8]);
  assert.equal(meta.mime, 'image/jpeg');
  const opened = await decryptMedia(ciphertext, meta);
  assert.equal(opened.type, 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await opened.arrayBuffer())], [...new Uint8Array(await jpeg().arrayBuffer())]);
  const other = await encryptMedia(jpeg());
  await assert.rejects(() => decryptMedia(ciphertext, { ...meta, key: other.meta.key }));
  const tampered = ciphertext.slice();
  tampered[3] ^= 1;
  await assert.rejects(() => decryptMedia(tampered, meta));
});

test('the upload is handed ciphertext only, and the message carries the key', async () => {
  let uploaded = null;
  const fakeUpload = async (bytes, options) => {
    uploaded = { bytes, options };
    return { url: 'https://media.example/abc' };
  };
  const entry = await uploadPrivateMedia(jpeg(), ['https://media.example'], fakeUpload);
  assert.equal(entry.url, 'https://media.example/abc');
  assert.ok(isPrivateMedia(entry));
  assert.ok(uploaded.bytes instanceof Uint8Array);
  assert.notDeepEqual([...uploaded.bytes.slice(0, 2)], [0xff, 0xd8]);
  assert.deepEqual(uploaded.options, { servers: ['https://media.example'] });
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => uploaded.bytes.buffer });
  const src = await openPrivateMedia(entry, fetchImpl);
  assert.match(src, /^blob:/);
  const blob = resolveObjectURL(src);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [...new Uint8Array(await jpeg().arrayBuffer())]);
});

test('a host that refuses the encrypted file fails the send, with no plaintext retry', async () => {
  const refused = async () => { throw new Error('415 unsupported type'); };
  await assert.rejects(() => uploadPrivateMedia(jpeg(), ['https://media.example'], refused), /415/);
  const composer = fs.readFileSync(new URL('../features/chat/useComposer.js', import.meta.url), 'utf8');
  assert.equal(composer.includes('uploadToBlossom'), false);
  assert.match(composer, /uploadPrivateMedia\(compressedFile/);
});

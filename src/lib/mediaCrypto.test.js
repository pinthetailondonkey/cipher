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

test('an encrypted photo goes to an http host and comes back, with a throwaway key bound to that host', async () => {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const { verifyEvent } = await import('nostr-tools');
  const stored = new Map();
  const seenAuth = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'PUT' && req.url === '/upload') {
        const auth = JSON.parse(Buffer.from(String(req.headers.authorization).replace(/^Nostr /, ''), 'base64url').toString());
        seenAuth.push(auth);
        const hash = createHash('sha256').update(body).digest('hex');
        const authOk = verifyEvent(auth) && auth.kind === 24242
          && auth.tags.some(([k, v]) => k === 'x' && v === hash)
          && auth.tags.some(([k, v]) => k === 'server' && v === '127.0.0.1')
          && req.headers['content-type'] === 'application/octet-stream';
        if (!authOk) { res.writeHead(401); res.end(); return; }
        stored.set(hash, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/${hash}`, sha256: hash, size: body.length, type: 'application/octet-stream' }));
        return;
      }
      const blob = stored.get(req.url.slice(1));
      if (req.method === 'GET' && blob) { res.writeHead(200); res.end(blob); return; }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const host = `http://127.0.0.1:${server.address().port}`;
    const entry = await uploadPrivateMedia(jpeg(), [host]);
    assert.match(entry.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}$/);
    const [stored0] = stored.values();
    assert.notDeepEqual([...stored0.subarray(0, 2)], [0xff, 0xd8]);
    const src = await openPrivateMedia(entry);
    const opened = resolveObjectURL(src);
    assert.deepEqual([...new Uint8Array(await opened.arrayBuffer())], [...new Uint8Array(await jpeg().arrayBuffer())]);
    // A second photo is signed by a different throwaway key.
    await uploadPrivateMedia(jpeg(), [host]);
    assert.equal(seenAuth.length, 2);
    assert.notEqual(seenAuth[0].pubkey, seenAuth[1].pubkey);
  } finally {
    server.close();
  }
});

test('an onion http host and an https host are both tried, and a host that answers for another file is refused', async () => {
  const { uploadCiphertext } = await import('./mediaCrypto.js');
  const bytes = new Uint8Array([9, 8, 7]);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, redirect: options.redirect });
    const hash = options.headers['X-SHA-256'];
    if (url.startsWith('http://wrong')) return { ok: true, json: async () => ({ url: 'https://wrong/x', sha256: 'f'.repeat(64), size: 3 }) };
    return { ok: true, json: async () => ({ url: `${new URL(url).origin}/${hash}`, sha256: hash, size: 3 }) };
  };
  const onion = await uploadCiphertext(bytes, { servers: ['http://media2abc.onion'], fetchImpl });
  assert.match(onion.url, /^http:\/\/media2abc\.onion\/[0-9a-f]{64}$/);
  const https = await uploadCiphertext(bytes, { servers: ['https://media.example'], fetchImpl });
  assert.match(https.url, /^https:\/\/media\.example\//);
  await assert.rejects(() => uploadCiphertext(bytes, { servers: ['http://wrong', 'ftp://nope'], fetchImpl }), /different file.*ftp:\/\/nope/);
  assert.ok(calls.every((call) => call.redirect === 'error'));
  assert.deepEqual(calls.map((call) => call.url), ['http://media2abc.onion/upload', 'https://media.example/upload', 'http://wrong/upload']);
});

test('the media host rows name what the host learns', async () => {
  const { EGRESS } = await import('./egress.js');
  for (const row of EGRESS.filter((item) => item.id.startsWith('blossom-'))) {
    assert.match(row.sees, /encrypted file/);
    assert.match(row.sees, /each reader.s IP and when they opened it/);
    assert.match(row.sees, /Not the content/);
  }
});

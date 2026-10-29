import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { verifyEvent } from 'nostr-tools';
import { EGRESS, FOUNDER_ONION_DOORS, blossomServers } from './egress.js';
import { decryptMedia, encryptMedia, uploadCiphertext } from './mediaCrypto.js';

// OPSEC 2026-10-29 — the media door through the path an upload actually takes.
//
// egress.test.js asks what the rows resolve to. This file asks what the app
// dials, which is the question that matters: a build whose media door is lit
// must send the file to the door and nowhere else, and a build whose door is
// dark must send it to the shipped hosts and nowhere else. Never both, and a
// host that answers for a different file is refused either way.
//
// The host below is a loopback stand-in for the founder's Blossom server,
// bound to 127.0.0.1 on a kernel-chosen port. Nothing here reaches a network.
// The door address is a fixture, because the real one must never be in this
// file; the forwarder plays the part of Tor, so the app dials an onion name
// and the bytes land on the stub.

const CLEARNET = ['https://blossom.primal.net', 'https://nostr.build', 'https://blossom.band'];
const MEDIA_ROWS = EGRESS.filter((row) => row.role === 'Media host').map((row) => row.id);
const DOOR = 'http://mediadoormediadoor.onion';

const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8])], { type: 'image/jpeg' });

// A Blossom-shaped host: PUT /upload with the signed auth header, GET /<hash>
// to read it back. It answers with the descriptor a real host sends, so the
// app's own checks run against it unaltered.
async function startMediaHost() {
  const stored = new Map();
  const auths = [];
  let origin = '';
  // The name the host gives out with each file. A real hidden-service host
  // answers with its own onion name, not the address Tor reached it on, so the
  // descriptor below carries the name the app dialled.
  const publicName = new URL(DOOR).origin;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'PUT' && req.url === '/upload') {
        const raw = Buffer.from(String(req.headers.authorization).replace(/^Nostr /, ''), 'base64url').toString();
        const auth = JSON.parse(raw);
        auths.push(auth);
        const hash = createHash('sha256').update(body).digest('hex');
        const authOk = verifyEvent(auth) && auth.kind === 24242
          && auth.tags.some(([k, v]) => k === 'x' && v === hash)
          && auth.tags.some(([k, v]) => k === 'server' && v === 'mediadoormediadoor.onion')
          && req.headers['content-type'] === 'application/octet-stream';
        if (!authOk) { res.writeHead(401); res.end(); return; }
        stored.set(hash, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: `${publicName}/${hash}`, sha256: hash, size: body.length, type: 'application/octet-stream' }));
        return;
      }
      const blob = stored.get(String(req.url).slice(1));
      if (req.method === 'GET' && blob) { res.writeHead(200); res.end(blob); return; }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, stored, auths, close: () => server.close() };
}

// Tor's part: the app dials the onion name, the bytes reach the stand-in host.
function throughTor(host, dialed) {
  return async (url, options = {}) => {
    dialed.push(url);
    const target = new URL(url);
    const next = `${host.origin}${target.pathname}`;
    if (!options.method) return fetch(next);
    return fetch(next, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      redirect: options.redirect,
    });
  };
}

const dark = () => {
  const saved = new Map(MEDIA_ROWS.map((id) => [id, FOUNDER_ONION_DOORS[id]]));
  for (const id of MEDIA_ROWS) FOUNDER_ONION_DOORS[id] = '';
  return () => { for (const [id, value] of saved) FOUNDER_ONION_DOORS[id] = value; };
};

const light = (address) => {
  const saved = new Map(MEDIA_ROWS.map((id) => [id, FOUNDER_ONION_DOORS[id]]));
  for (const id of MEDIA_ROWS) FOUNDER_ONION_DOORS[id] = address;
  return () => { for (const [id, value] of saved) FOUNDER_ONION_DOORS[id] = value; };
};

test('door dark: the upload dials a shipped media host and no onion', async () => {
  const restore = dark();
  const dialed = [];
  try {
    const { ciphertext } = await encryptMedia(jpeg());
    const fetchImpl = async (url, options) => {
      dialed.push(url);
      const hash = options.headers['X-SHA-256'];
      return { ok: true, json: async () => ({ url: `${new URL(url).origin}/${hash}`, sha256: hash, size: options.body.length }) };
    };
    await uploadCiphertext(ciphertext, { servers: blossomServers({ overrides: {}, lists: {} }), fetchImpl });
    // The first shipped host takes the file and the walk stops there, as it
    // always has; what matters is that only a shipped host was dialled.
    assert.deepEqual(dialed, [`${CLEARNET[0]}/upload`]);
    assert.equal(dialed.some((url) => url.includes('.onion')), false);
  } finally {
    restore();
  }
});

test('door lit: the upload dials the door once and none of the shipped hosts', async () => {
  const restore = light(DOOR);
  const dialed = [];
  try {
    const { ciphertext } = await encryptMedia(jpeg());
    const fetchImpl = async (url, options) => {
      dialed.push(url);
      const hash = options.headers['X-SHA-256'];
      return { ok: true, json: async () => ({ url: `${new URL(url).origin}/${hash}`, sha256: hash, size: options.body.length }) };
    };
    await uploadCiphertext(ciphertext, { servers: blossomServers({ overrides: {}, lists: {} }), fetchImpl });
    assert.deepEqual(dialed, [`${DOOR}/upload`], 'one door serves the trio: exactly one dial, at the door');
    for (const host of CLEARNET) {
      assert.equal(dialed.some((url) => url.startsWith(host)), false, `${host} must not be dialled when the door is lit`);
    }
  } finally {
    restore();
  }
});

test('door lit: a photo goes up through the door and comes back, sealed at both ends', async () => {
  const host = await startMediaHost();
  const restore = light(DOOR);
  const dialed = [];
  try {
    const { ciphertext, meta } = await encryptMedia(jpeg());
    const fetchImpl = throughTor(host, dialed);
    const descriptor = await uploadCiphertext(ciphertext, { servers: blossomServers({ overrides: {}, lists: {} }), fetchImpl });
    assert.equal(new URL(descriptor.url).hostname, 'mediadoormediadoor.onion');

    // The host holds ciphertext under a throwaway key, and the key it was
    // signed with is not the sender's identity.
    const [stored] = host.stored.values();
    assert.notDeepEqual([...stored.subarray(0, 2)], [0xff, 0xd8]);
    assert.equal(host.auths.length, 1);
    assert.equal(host.auths[0].kind, 24242);

    // Read it back the way a reader's bubble does: fetch the ciphertext, then
    // decrypt with the key that rode in the message.
    const response = await fetchImpl(descriptor.url);
    const opened = await decryptMedia(new Uint8Array(await response.arrayBuffer()), meta);
    assert.deepEqual(
      [...new Uint8Array(await opened.arrayBuffer())],
      [...new Uint8Array(await jpeg().arrayBuffer())],
    );

    // Both dials went to the door; the stand-in only saw them because the
    // forwarder carried them there.
    assert.deepEqual(dialed, [`${DOOR}/upload`, `${DOOR}/${createHash('sha256').update(ciphertext).digest('hex')}`]);
  } finally {
    restore();
    host.close();
  }
});

test('door lit with a pasted host: the paste is dialled first, then the door, and never the defaults', async () => {
  const restore = light(DOOR);
  const dialed = [];
  try {
    const { ciphertext } = await encryptMedia(jpeg());
    const fetchImpl = async (url, options) => {
      dialed.push(url);
      const hash = options.headers['X-SHA-256'];
      return { ok: true, json: async () => ({ url: `${new URL(url).origin}/${hash}`, sha256: hash, size: options.body.length }) };
    };
    const servers = blossomServers({ overrides: { 'blossom-primal': 'https://pasted.example' }, lists: {} });
    // The list itself is asserted, not just the dial: a successful paste would
    // stop the walk before the door either way, so the dial alone could not
    // tell a lit door from a dark one here.
    assert.deepEqual(servers, ['https://pasted.example', DOOR]);
    await uploadCiphertext(ciphertext, { servers, fetchImpl });
    // The paste is first in the rank order, so it takes the file and the walk
    // stops; the point is that the door comes after it and the defaults never.
    assert.deepEqual(dialed, ['https://pasted.example/upload']);
    for (const host of CLEARNET) {
      assert.equal(dialed.some((url) => url.startsWith(host)), false);
    }
  } finally {
    restore();
  }
});

test('door lit: a host that answers for a different file is refused, not stored', async () => {
  const restore = light(DOOR);
  try {
    const { ciphertext } = await encryptMedia(jpeg());
    const lying = async (url, options) => ({
      ok: true,
      json: async () => ({ url: `${new URL(url).origin}/x`, sha256: 'f'.repeat(64), size: options.body.length }),
    });
    await assert.rejects(
      () => uploadCiphertext(ciphertext, { servers: blossomServers({ overrides: {}, lists: {} }), fetchImpl: lying }),
      /different file/,
    );
  } finally {
    restore();
  }
});

test('every media row off: nothing is dialled and the send fails rather than falling back', async () => {
  const restore = light(DOOR);
  const dialed = [];
  try {
    const { ciphertext } = await encryptMedia(jpeg());
    const servers = blossomServers({
      overrides: { 'blossom-primal': 'off', 'blossom-nostr-build': 'off', 'blossom-band': 'off' },
      lists: {},
    });
    assert.deepEqual(servers, []);
    await assert.rejects(
      () => uploadCiphertext(ciphertext, { servers, fetchImpl: async (url) => { dialed.push(url); throw new Error('dialled'); } }),
      /No media host took the encrypted file/,
    );
    assert.deepEqual(dialed, []);
  } finally {
    restore();
  }
});

test('the door is dark in every build that is not the desktop build', async () => {
  // The rows are what a web bundle gets: the shipped trio, whatever env the
  // machine happens to carry, because the door is read behind the desktop
  // marker and this test process is not a desktop build.
  const { FOUNDER_MEDIA_ONION } = await import('./egress.js');
  assert.equal(FOUNDER_MEDIA_ONION, '');
  assert.deepEqual(blossomServers({ overrides: {}, lists: {} }), CLEARNET);
  assert.equal(MEDIA_ROWS.length, 3);
});


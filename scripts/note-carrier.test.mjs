// The carrier's one promise, executed: a note is handed over once, and the
// server holds ciphertext it cannot open. Everything here runs against a real
// server on a loopback port and a temporary data directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCarrier } from './note-carrier.mjs';

async function start() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'note-carrier-'));
  const { server, dir } = await createCarrier({ dataDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return { server, dir, base, close: () => new Promise((r) => server.close(r)) };
}

// The sender's own id: 16 random bytes, base64url — the same shape the client
// derives and binds into the ciphertext as additional data.
const newId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
const SEALED = Uint8Array.from({ length: 48 }, (_, i) => (i * 7) % 251);

test('a note is handed over exactly once, even when two readers ask at once', async () => {
  const c = await start();
  try {
    const id = newId();
    const stored = await fetch(`${c.base}/api/notes/${id}`, { method: 'POST', body: SEALED });
    assert.equal(stored.status, 201);

    const [a, b] = await Promise.all([
      fetch(`${c.base}/api/notes/${id}`),
      fetch(`${c.base}/api/notes/${id}`),
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [200, 404], 'one reader wins, one is told it is gone');
    const winner = a.status === 200 ? a : b;
    assert.deepEqual(new Uint8Array(await winner.arrayBuffer()), SEALED, 'the bytes come back whole');
    const loser = a.status === 404 ? a : b;
    assert.deepEqual(await loser.json(), { error: 'gone' });

    // Nothing is left behind for a third reader, or for the disk.
    assert.equal((await fetch(`${c.base}/api/notes/${id}`)).status, 404);
    const left = (await readdir(c.dir)).filter((name) => name.startsWith(id));
    assert.deepEqual(left, []);
  } finally { await c.close(); }
});

test('the server stores exactly what it was given: no key, no plaintext, no rewrite', async () => {
  const c = await start();
  try {
    const id = newId();
    assert.equal((await fetch(`${c.base}/api/notes/${id}`, { method: 'POST', body: SEALED })).status, 201);
    const onDisk = await readFile(path.join(c.dir, `${id}.note`));
    assert.deepEqual(new Uint8Array(onDisk), SEALED);
    // A note never existed under any other name: one file, sealed, then gone.
    assert.deepEqual((await readdir(c.dir)).filter((n) => n.endsWith('.note')), [`${id}.note`]);
  } finally { await c.close(); }
});

test('an id that is already taken is refused, never overwritten', async () => {
  const c = await start();
  try {
    const id = newId();
    assert.equal((await fetch(`${c.base}/api/notes/${id}`, { method: 'POST', body: SEALED })).status, 201);
    const again = await fetch(`${c.base}/api/notes/${id}`, { method: 'POST', body: Uint8Array.from([1, 2, 3]) });
    assert.equal(again.status, 409);
    const read = await fetch(`${c.base}/api/notes/${id}`);
    assert.equal(read.status, 200);
    assert.deepEqual(new Uint8Array(await read.arrayBuffer()), SEALED, 'the first note is the one handed over');
  } finally { await c.close(); }
});

test('shapes the carrier refuses: empty, oversized, a made-up id, a non-note path', async () => {
  const c = await start();
  try {
    const id = newId();
    assert.equal((await fetch(`${c.base}/api/notes/${id}`, { method: 'POST', body: '' })).status, 400);
    const big = new Uint8Array(20 * 1024);
    assert.equal((await fetch(`${c.base}/api/notes/${id}`, { method: 'POST', body: big })).status, 413);
    assert.equal((await fetch(`${c.base}/api/notes/short`, { method: 'POST', body: SEALED })).status, 400);
    const bad = await fetch(`${c.base}/api/notes/AAAA-AAAA-AAAA-AAAA-A`, { method: 'POST', body: SEALED });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${c.base}/api/notes/nope`)).status, 400);
    assert.equal((await fetch(`${c.base}/nothing-here`)).status, 404);
  } finally { await c.close(); }
});

test('the public page says one read and carries no host but its own', async () => {
  const c = await start();
  try {
    for (const route of ['/', '/note']) {
      const page = await fetch(`${c.base}${route}`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /text\/html/);
      assert.match(page.headers.get('content-security-policy') || '', /connect-src 'self'/);
      const text = await page.text();
      assert.match(text, /A note that reads once/);
      assert.match(text, /Open it and it is gone from the server/);
      // The page reads the key from the fragment and sends only the id: the
      // fetch URL is built from the derived id, never from the fragment.
      assert.match(text, /'\/api\/notes\/' \+ id/);
      assert.match(text, /location\.hash\.slice\(1\)/);
      assert.doesNotMatch(text, /'\/api\/notes\/' \+ window\.location\.hash/);
    }
    const health = await fetch(`${c.base}/healthz`);
    assert.deepEqual(await health.json(), { ok: true });
  } finally { await c.close(); }
});

test('an OPTIONS preflight is answered so the app may post from its own origin', async () => {
  const c = await start();
  try {
    const pre = await fetch(`${c.base}/api/notes/${newId()}`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-methods') || '', /POST/);
  } finally { await c.close(); }
});

// The page's own script ships as text, so a mistake in its escaping is
// invisible to every request test above — and one was: the id transform wrote
// `\+` and `\/` inside a template literal, the browser received `/+/g` and
// `///g`, and refused to parse the whole script. The page could never show a
// note. This asks the browser's question: does what we serve parse?
test("the page's own script parses as served, and its id is the app's base64url", async () => {
  const c = await start();
  try {
    const text = await (await fetch(`${c.base}/note`)).text();
    const script = text.split('<script>')[1].split('</script>')[0];
    assert.ok(script && script.trim().length > 0, 'the page carries a script');
    assert.doesNotThrow(() => new Function(script), 'the page script must parse as the browser receives it');
    // The id the page derives is the same one the app posts: base64url, no
    // padding. Run the served line itself, so the check cannot drift from it.
    const line = script.split('\n').find((l) => l.includes('btoa(idBin)'));
    assert.ok(line, 'the page still derives the id with btoa');
    const derive = new Function('btoa', 'idBin', `${line.trim()} return id;`);
    for (const bytes of [[1, 2, 3], [0xfb, 0xef, 0xbe, 0xaa, 0xbb, 0xff, 0xee], Array.from({ length: 16 }, (_, i) => (i * 17) % 256)]) {
      const bin = Buffer.from(bytes);
      assert.equal(derive(() => bin.toString('base64'), bin.toString('latin1')), bin.toString('base64url'), `id for ${bytes.length} bytes`);
    }
  } finally { await c.close(); }
});

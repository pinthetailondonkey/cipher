#!/usr/bin/env node
// The one-read note carrier.
//
// A note is stored as ciphertext under a random id and handed over exactly
// once: the first GET that names the id renames the blob out of the way,
// returns it, and deletes it. The rename is the one job this server has —
// two requests racing for the same note cannot both win it.
//
// The server never holds a key and never sees one. The link fragment carries
// the id, the AES-GCM key and the iv; the fragment is never sent to this
// process, so a copy of this server's whole data directory opens nothing.
// An id is 16 random bytes: no order, no account, no way to walk from one
// note to the next.
//
// Plain Node, no dependencies, no build. The founder runs it by hand; the
// instruction sheet beside this file is written for someone who is not a
// developer. (S4, D2)
import { createServer } from 'node:http';
import { mkdir, link, rename, unlink, readFile, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ID_RE = /^[A-Za-z0-9_-]{22}$/; // base64url of 16 bytes, no padding
const DEFAULT_MAX_BYTES = 16 * 1024; // a note, sealed; 8000 characters of text
const DEFAULT_PORT = 8789;

const json = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
};

// The reading page. It never talks to any host but its own, it never writes
// the note anywhere, and it says plainly what it does: one read, then gone.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>A note that reads once</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d10; color: #e8eaed;
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 24px; }
  main { width: 100%; max-width: 560px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  p.lede { margin: 0 0 20px; color: #9aa0a6; }
  #note { white-space: pre-wrap; overflow-wrap: anywhere; background: #14171c; border: 1px solid #262b33;
    border-radius: 14px; padding: 16px; margin: 0; font: inherit; }
  #state { color: #9aa0a6; margin: 16px 0 0; }
  button { font: inherit; padding: 10px 16px; border-radius: 12px; border: 1px solid #333a45;
    background: #1b1f26; color: #e8eaed; cursor: pointer; }
  button:active { transform: translateY(1px); }
</style>
</head>
<body>
<main>
  <h1>A note that reads once</h1>
  <p class="lede">Open it and it is gone from the server. There is no second read, not even for you.</p>
  <pre id="note" hidden></pre>
  <p id="state">Opening…</p>
  <p><button id="again" hidden>Copy the text</button></p>
</main>
<script>
(function () {
  var state = document.getElementById('state');
  var note = document.getElementById('note');
  var again = document.getElementById('again');
  function fail(text) { state.textContent = text; }
  function b64url(text) {
    var b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  var raw;
  try { raw = b64url(location.hash.slice(1)); } catch (e) { fail('This link is not a note link.'); return; }
  // A relay note is a different fragment shape: key, iv and note hash, 76
  // bytes, 102 base64url characters. This host holds no such note and never
  // will — it is not on this server at all — so the person is told where the
  // link does open instead of being told their link is broken.
  if (raw.length === 76) { fail('This note opens in the Cipher app, not on this page.'); return; }
  if (raw.length !== 61 || raw[0] !== 2) { fail('This link is not a note link.'); return; }
  var idBin = '';
  for (var j = 1; j < 17; j++) idBin += String.fromCharCode(raw[j]);
  var id = btoa(idBin).replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
  var key = raw.slice(17, 49);
  var iv = raw.slice(49, 61);
  fetch('/api/notes/' + id, { cache: 'no-store', credentials: 'omit' })
    .then(function (r) {
      if (!r.ok) throw new Error(r.status === 404 ? 'This note has already been read, or it was never here.' : 'The note could not be opened.');
      return r.arrayBuffer();
    })
    .then(function (buf) {
      // The note's own id is bound into the seal: a blob swapped for another
      // one under the same link does not open.
      return crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
        .then(function (k) {
          return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv, additionalData: raw.slice(1, 17) }, k, buf);
        });
    })
    .then(function (plain) {
      var payload = JSON.parse(new TextDecoder().decode(plain));
      note.textContent = String(payload && payload.t || '');
      note.hidden = false;
      again.hidden = false;
      state.textContent = 'Read. It has been deleted from the server.';
      history.replaceState(null, '', location.pathname);
      again.onclick = function () {
        navigator.clipboard.writeText(note.textContent).then(function () {
          again.textContent = 'Copied';
        }, function () { again.textContent = 'Select the text and copy it'; });
      };
    })
    .catch(function (e) { fail(e && e.message ? e.message : 'The note could not be opened.'); });
})();
</script>
</body>
</html>`;

function pageResponse(res) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(PAGE);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // Drained, not destroyed: the refusal is the answer, and a reset
        // mid-upload would read as a broken host rather than a stated limit.
        chunks.length = 0;
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// A note id is a file name and nothing else: 16 random bytes, base64url.
function notePath(dir, id, suffix) {
  return path.join(dir, `${id}.${suffix}`);
}

export async function createCarrier({ dataDir, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!dataDir) throw new Error('A data directory is required.');
  const dir = path.resolve(dataDir);
  await mkdir(dir, { recursive: true });

  // The writer picks the id: it is 16 random bytes from the sender's own
  // device, and it is bound into the ciphertext as AES-GCM's additional data,
  // so this server cannot swap one note for another under the same link. An
  // id that already exists is refused, never overwritten.
  const put = async (id, bytes) => {
    if (!ID_RE.test(String(id || ''))) return { error: 'bad-id', status: 400 };
    if (!bytes || bytes.length === 0) return { error: 'empty', status: 400 };
    if (bytes.length > maxBytes) return { error: 'large', status: 413 };
    // Written under a temporary name and linked into place: a reader can
    // never see half a note, a crash mid-write leaves only the temp file, and
    // link() refuses to replace an id that is already there.
    const tmp = notePath(dir, id, 'tmp');
    const final = notePath(dir, id, 'note');
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(tmp, final);
    } catch (error) {
      if (error && error.code === 'EEXIST') return { error: 'exists', status: 409 };
      throw error;
    } finally {
      await unlink(tmp).catch(() => {});
    }
    return { id };
  };

  // The one job: hand the note over once. rename() of a given path succeeds
  // exactly once, so this pair of calls is the whole concurrency story — a
  // second reader, a second tab or a second process cannot both take it.
  const take = async (id) => {
    if (!ID_RE.test(id)) return { error: 'bad-id', status: 400 };
    const final = notePath(dir, id, 'note');
    const claimed = notePath(dir, id, 'take');
    try {
      await rename(final, claimed);
    } catch (error) {
      if (error && error.code === 'ENOENT') return { error: 'gone', status: 404 };
      throw error;
    }
    try {
      const bytes = await readFile(claimed);
      return { bytes };
    } finally {
      await unlink(claimed).catch(() => {});
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://carrier.invalid');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/note')) {
      pageResponse(res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, { ok: true });
      return;
    }
    const posted = /^\/api\/notes\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (req.method === 'POST' && posted) {
      try {
        const bytes = await readBody(req, maxBytes);
        const made = await put(posted[1], bytes);
        if (made.error) {
          json(res, made.status, { error: made.error });
          return;
        }
        console.log('[note] stored', bytes.length, 'bytes');
        json(res, 201, { id: made.id });
      } catch (error) {
        if (error?.status === 413) {
          json(res, 413, { error: 'large' });
          return;
        }
        console.error('[note] store failed:', error?.message || error);
        json(res, 500, { error: 'failed' });
      }
      return;
    }
    const m = /^\/api\/notes\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      try {
        const got = await take(m[1]);
        if (got.error) {
          console.log('[note] handover refused:', got.error);
          json(res, got.status, { error: got.error });
          return;
        }
        console.log('[note] handed over once', got.bytes.length, 'bytes');
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': got.bytes.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'access-control-allow-origin': '*',
        });
        res.end(got.bytes);
      } catch (error) {
        console.error('[note] handover failed:', error?.message || error);
        json(res, 500, { error: 'failed' });
      }
      return;
    }
    json(res, 404, { error: 'not-found' });
  });

  return { server, dir, put, take };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.NOTE_DATA_DIR || path.resolve('note-data');
  const port = Number(process.env.NOTE_PORT || DEFAULT_PORT);
  const host = process.env.NOTE_HOST || '0.0.0.0';
  const maxBytes = Number(process.env.NOTE_MAX_BYTES || DEFAULT_MAX_BYTES);
  const { server } = await createCarrier({ dataDir, maxBytes });
  server.listen(port, host, () => {
    // No hostnames, keys or note ids in this line: the operator knows where
    // it runs, and the log never becomes a way to find a note.
    console.log(`[note] carrier listening on port ${port}, data in ${dataDir}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { MEDIA_FETCH_OPTIONS, MEDIA_REFERRER_POLICY, mediaFetch, mediaHref, mediaHostOf } from './mediaUrl.js';
import { setRelayOverride } from './egress.js';

// SEC-4: rendering wire-supplied media never contacts an unapproved origin.
//
// A malicious member writes a URL into a message body, a profile, or a
// listing, and the reader's browser fetches it while the bubble renders. That
// host is nowhere in egress.js, so the render path is the only place the
// address can be checked. Same-origin URLs and explicit media-server settings
// are the only HTTP origins allowed; redirects, Referer and credentials are
// refused at the fetch boundary.

const ORIGIN = 'https://cipher.example';
const APPROVED = ['https://host.example', 'http://media2abc.onion', 'http://127.0.0.1:8080'];

test('only same-origin or explicitly approved exact origins can render', () => {
  assert.equal(mediaHref('https://host.example/a.png', undefined, APPROVED), 'https://host.example/a.png');
  assert.equal(mediaHref('http://media2abc.onion/a.png', undefined, APPROVED), 'http://media2abc.onion/a.png');
  // Trimmed, and a shouting scheme or host is normalised rather than dialled
  // as written.
  assert.equal(mediaHref('  HTTPS://Host.EXAMPLE/a.png  ', undefined, APPROVED), 'https://host.example/a.png');
  assert.equal(mediaHref('https://host.example.attacker.invalid/a.png', undefined, APPROVED), '');
  assert.equal(mediaHref('http://host.example/a.png', undefined, ['https://host.example']), '');
  assert.equal(mediaHref('https://host.example:444/a.png', undefined, ['https://host.example']), '');
  assert.equal(mediaHref('https://user:pass@host.example/a.png', undefined, APPROVED), '');
  assert.equal(mediaHref('https://sender-chosen.invalid/a.png', undefined, APPROVED), '');
  assert.equal(mediaHref('https://cipher.example/a.png', ORIGIN, []), 'https://cipher.example/a.png',
    'same-origin media stays local to the app');
  // Local schemes render but were never a host to contact.
  assert.equal(mediaHref('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(mediaHref('blob:https://cipher.example/1234'), 'blob:https://cipher.example/1234');
  // An address a plain <img> would hand to the browser and the browser would
  // do something with: nothing here dials it.
  for (const stray of ['javascript:void(0)', 'ftp://files.example/a.png', 'mailto:a@b.c', 'file:///tmp/a.png', 'ws://relay.example/x', '']) {
    assert.equal(mediaHref(stray), '', `${stray} must not reach an element or a fetch`);
  }
  assert.equal(mediaHref('   '), '');
  assert.equal(mediaHref(null), '');
  assert.equal(mediaHref(undefined), '');
  assert.equal(mediaHref({ url: 'https://host.example' }), '');
  // A relative address resolves against the document, the way the browser
  // would have resolved it before this gate existed.
  assert.equal(mediaHref('/local.png', ORIGIN), `${ORIGIN}/local.png`);
  assert.equal(mediaHref('local.png', ORIGIN), `${ORIGIN}/local.png`);
  // With no document to resolve against, a relative address is refused rather
  // than guessed at.
  assert.equal(mediaHref('local.png', undefined), '');
  assert.equal(mediaHref('local.png', ''), '');
});

test('the host is named for a host, and blank when nothing left the device', () => {
  assert.equal(mediaHostOf('https://host.example/a.png', APPROVED), 'host.example');
  assert.equal(mediaHostOf('http://127.0.0.1:8080/a.png', APPROVED), '127.0.0.1:8080');
  assert.equal(mediaHostOf('data:image/png;base64,AAAA'), '');
  assert.equal(mediaHostOf('blob:https://cipher.example/1'), '');
  assert.equal(mediaHostOf('javascript:void(0)'), '');
});

test('a read is one no-referrer, credential-free GET and blocks unapproved origins', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true }; };
  await mediaFetch('https://host.example/a.png', fetchImpl, { approvedServers: APPROVED });
  assert.equal(calls.length, 1, 'one dial, at the address the sender named');
  assert.equal(calls[0].url, 'https://host.example/a.png');
  assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(calls[0].options, { ...MEDIA_FETCH_OPTIONS });
  assert.equal(MEDIA_REFERRER_POLICY, 'no-referrer');
  // A strapped address never reaches the transport at all.
  await assert.rejects(async () => mediaFetch('javascript:void(0)', fetchImpl, { approvedServers: APPROVED }), /names no host to dial/);
  await assert.rejects(async () => mediaFetch('https://sender-chosen.invalid/pixel', fetchImpl, { approvedServers: APPROVED }), /names no host to dial/);
  assert.equal(calls.length, 1, 'the stray dial changed nothing');
});

test('a configured Blossom or onion origin is approved by exact origin', () => {
  const previous = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  try {
    setRelayOverride('blossom-primal', 'https://custom-media.example');
    assert.equal(mediaHref('https://custom-media.example/a.png'), 'https://custom-media.example/a.png');
    assert.equal(mediaHref('https://custom-media.example.attacker.invalid/a.png'), '');
    const onion = `http://${'a'.repeat(56)}.onion`;
    setRelayOverride('blossom-primal', onion);
    assert.equal(mediaHref(`${onion}/a.png`), `${onion}/a.png`);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }

  const connections = fs.readFileSync(path.resolve('src/components/chat/Connections.jsx'), 'utf8');
  for (const id of ['blossom-primal', 'blossom-nostr-build', 'blossom-band']) {
    assert.ok(connections.includes(`id: '${id}'`), `${id} can be configured in Connections`);
  }
  assert.match(connections, /setRelayOverride\(id, url\)/, 'the setting updates the same egress configuration as the gate');
});

// The gate is only worth what its doors are worth, so the doors are asserted
// as source, the way egress.test.js asserts the wall. Every place a picture,
// voice note, or face can turn a wire URL into a request must run through
// lib/mediaUrl, and every image element must carry the referrer policy.
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(name) && !name.endsWith('.test.js') && !name.endsWith('.test.jsx')) out.push(full);
  }
  return out;
}

test('every door that can dial a wire URL runs through the gate', () => {
  const root = path.resolve('src');
  const rel = (file) => path.relative(root, file);
  const DOORS = [
    'components/ui/Picture.jsx',
    'components/ui/Avatar.jsx',
    'components/ui/PrivateMedia.jsx',
    'components/chat/VoiceNote.jsx',
    'lib/mediaCrypto.js',
  ];
  for (const door of DOORS) {
    const source = fs.readFileSync(path.join(root, door), 'utf8');
    assert.match(source, /from '\.\..*lib\/mediaUrl|from '\.\/mediaUrl\.js'/,
      `${door} must take its address from the gate`);
  }
  // Picture is the shared door: it is where a plain URL becomes an element.
  const picture = fs.readFileSync(path.join(root, 'components/ui/Picture.jsx'), 'utf8');
  assert.match(picture, /mediaHref\(src\)/, 'the source is approved before render');
  assert.match(picture, /mediaFetch\(href, globalThis\.fetch, \{ signal: controller\.signal \}\)/,
    'plain remote media is fetched into a blob so an img cannot follow redirects');
  assert.match(picture, /<a href=\{shown\}/,
    'opening a linked picture uses its local blob instead of navigating through a remote redirect');
  assert.doesNotMatch(picture, /<a href=\{href\}/,
    'a link never bypasses redirect blocking by navigating to the original remote URL');
  assert.match(picture, /referrerPolicy=\{MEDIA_FETCH_OPTIONS\.referrerPolicy\}/);
  // The one fetch that reads ciphertext from a stranger's host.
  const media = fs.readFileSync(path.join(root, 'lib/mediaCrypto.js'), 'utf8');
  assert.match(media, /await mediaFetch\(href, fetchImpl, mediaPolicy\)/);
  assert.match(media, /const href = mediaHref\(entry\?\.url,/);

  // Every <img> in the app carries the policy. The raw mark is the one local
  // file and needs nothing, and is named rather than exempted by pattern.
  // The tag body is read as source text, so a multi-line element counts too;
  // a `>` inside a JSX expression in an attribute would cut it short, and no
  // image here has one.
  const LOCAL_ONLY = new Set(['components/Logo.jsx']);
  const leaked = [];
  for (const file of walk(root)) {
    if (LOCAL_ONLY.has(rel(file))) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const [index, tag] of [...source.matchAll(/<img\b[^>]*>/g)].entries()) {
      if (!/referrerPolicy/.test(tag[0])) leaked.push(`${rel(file)}: img #${index + 1}`);
    }
  }
  assert.deepEqual(leaked, [], 'an image element without the referrer policy');
});

test('the document floor says the same thing as every door', () => {
  const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
  assert.match(html, /<meta name="referrer" content="no-referrer" \/>/);
});

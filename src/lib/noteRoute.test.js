import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { noteFragmentFor, rememberNoteRoute } from './noteRoute.js';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('only /note with a fragment opens the reader', () => {
  // No tab memory in this process: an address alone decides nothing below.
  assert.equal(noteFragmentFor({ pathname: '/note', hash: '#abc' }), 'abc');
  assert.equal(noteFragmentFor({ pathname: '/note/', hash: '#abc' }), 'abc', 'the trailing slash still counts');
  assert.equal(noteFragmentFor({ pathname: '/note', hash: '' }), null, 'no fragment is no note');
  assert.equal(noteFragmentFor({ pathname: '/note', hash: '#' }), null);
  assert.equal(noteFragmentFor({ pathname: '/notebook', hash: '#abc' }), null, 'a lookalike path is not the route');
  assert.equal(noteFragmentFor({ pathname: '/note/x', hash: '#abc' }), null);
  assert.equal(noteFragmentFor({ pathname: '/', hash: '#abc' }), null, 'a fragment elsewhere is not a note');
  assert.equal(noteFragmentFor({}), null, 'nothing at all decides nothing');
});

// The reader clears the fragment from the address bar by design, so the address
// alone cannot carry the route past that moment. The tab keeps it — and only
// the tab, and only on the note path.
test('the tab holds the note route after the fragment leaves the address bar', () => {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  try {
    rememberNoteRoute('frag');
    assert.equal(noteFragmentFor({ pathname: '/note', hash: '' }), 'frag',
      'a reload of the same tab still lands on the reader');
    assert.equal(noteFragmentFor({ pathname: '/note', hash: '#other' }), 'other',
      'a fresh link wins over what the tab remembers');
    assert.equal(noteFragmentFor({ pathname: '/', hash: '' }), null,
      'the tab memory never captures any other path');
    assert.equal(noteFragmentFor({ pathname: '/notebook', hash: '' }), null,
      'nor a lookalike path');
    assert.equal(noteFragmentFor({ pathname: '/note' }), 'frag',
      'a fragment-less /note in the same tab is still the note screen');
  } finally {
    delete globalThis.sessionStorage;
  }
});

test('the reader takes no account, no store and no identity — that is its whole claim', () => {
  const screen = read('../BurnNoteReader.jsx');
  const network = read('./noteReader.js');
  for (const [name, source] of [['the reader screen', screen], ['its network call', network]]) {
    assert.doesNotMatch(source, /chatStore/, `${name} must not read the chat store`);
    assert.doesNotMatch(source, /useIdentity|identity\.sk/, `${name} must not ask for an identity`);
    assert.doesNotMatch(source, /from\s+['"][^'"]*vault/i, `${name} must not import a vault`);
  }
  // The note host and the relays are the only things this page may contact.
  assert.doesNotMatch(screen, /https?:\/\//, 'the screen names no host');
});

test('the reader is mounted ahead of every identity return in App', () => {
  const app = read('../App.jsx');
  const gate = app.indexOf('noteFragmentFor(window.location)');
  const loading = app.indexOf('if (identity.loadingSession)');
  const lock = app.indexOf('if (!identity.sk)');
  assert.ok(gate > 0, 'App decides the note route itself');
  assert.ok(gate < loading, 'the note route is answered before the session spinner');
  assert.ok(gate < lock, 'the note route is answered before the lock screen');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { noteFragmentFor } from './noteRoute.js';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('only /note with a fragment opens the reader', () => {
  assert.equal(noteFragmentFor({ pathname: '/note', hash: '#abc' }), 'abc');
  assert.equal(noteFragmentFor({ pathname: '/note/', hash: '#abc' }), 'abc', 'the trailing slash still counts');
  assert.equal(noteFragmentFor({ pathname: '/note', hash: '' }), null, 'no fragment is no note');
  assert.equal(noteFragmentFor({ pathname: '/note', hash: '#' }), null);
  assert.equal(noteFragmentFor({ pathname: '/notebook', hash: '#abc' }), null, 'a lookalike path is not the route');
  assert.equal(noteFragmentFor({ pathname: '/note/x', hash: '#abc' }), null);
  assert.equal(noteFragmentFor({ pathname: '/', hash: '#abc' }), null, 'a fragment elsewhere is not a note');
  assert.equal(noteFragmentFor({}), null, 'nothing at all decides nothing');
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

// The desktop build is the only build carrying an onion group door, and the
// packaging step consumes its output. These are the two ways that build can
// fail while an older, longer-lived dist-desktop still sits on disk: the door
// is not configured, and the build itself falls over. Neither may leave a
// folder that packaging would accept.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EGRESS } from '../src/lib/egress.js';
import { MEDIA_REFUSAL, manifestFor, mediaDoorRefusal } from './build-desktop.mjs';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'build-desktop.mjs');

// An older, complete build from this very source: the one case where a stale
// folder would otherwise pass every check, because its hashes still match.
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-desktop-build-'));
  fs.mkdirSync(path.join(dir, 'dist-desktop'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist-desktop', 'index.html'), 'an older build');
  fs.writeFileSync(path.join(dir, 'dist-desktop', 'cipher-desktop-build.json'), JSON.stringify({
    desktop: true, builtAt: new Date().toISOString(), sourceSha: 'a'.repeat(40), sourceDirty: false, files: {},
  }));
  return dir;
}

const run = (cwd, env = {}) => spawnSync(process.execPath, [script], {
  cwd,
  encoding: 'utf8',
  env: { ...process.env, VITE_GROUP_ONION: '', ...env },
});

const stale = (dir) => fs.existsSync(path.join(dir, 'dist-desktop', 'index.html'));
const manifest = (dir) => fs.existsSync(path.join(dir, 'dist-desktop', 'cipher-desktop-build.json'));

test('no door configured: the build refuses and the old output can no longer be packed', () => {
  const dir = workspace();
  try {
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /build:desktop refuses: VITE_GROUP_ONION is missing/);
    // The old assets stay where they are, and nothing has deleted them; what
    // is gone is the manifest that would have let packaging accept them.
    assert.equal(stale(dir), true);
    assert.equal(manifest(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a door that is not an onion is refused the same way', () => {
  const dir = workspace();
  try {
    const result = run(dir, { VITE_GROUP_ONION: 'wss://groups.example.com' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refuses/);
    assert.equal(manifest(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The media door's refusal, run against the rows that actually ship.
//
// This test used to build its own three-row fixture carrying `gate: 'founder'`,
// which is a shape no shipped row has: the predicate looked for that field, the
// real rows never carry it, and the fixture proved only that the predicate
// agreed with itself. A predicate and its data can disagree indefinitely while
// the test supplies the data. So the cases below import the real EGRESS, and
// the fixture shape is kept only as the third case, where it must behave the
// same as the real rows do.
const FOUNDER_MEDIA_ROWS = [
  { id: 'blossom-primal', role: 'Media host', url: 'https://media.example', gate: 'founder' },
  { id: 'blossom-nostr-build', role: 'Media host', url: 'https://media.example', gate: 'founder' },
  { id: 'blossom-band', role: 'Media host', url: 'https://media.example', gate: 'founder' },
];

test('a cleartext media door is refused against the rows that ship', () => {
  const mediaRows = EGRESS.filter((row) => row.role === 'Media host');
  assert.equal(mediaRows.length, 3, `expected the media rows, measured ${mediaRows.length}`);
  // The live case: the rows are real, the door is a clear host, and the refusal
  // fires because the predicate reads the rows rather than a marker on them.
  assert.equal(mediaDoorRefusal({ mediaDoor: 'https://media.example', rows: EGRESS }), MEDIA_REFUSAL);
  // A loopback near-miss is not an onion either — the check is the shape, not
  // the word "example".
  assert.equal(mediaDoorRefusal({ mediaDoor: 'https://127.0.0.1:9050', rows: EGRESS }), MEDIA_REFUSAL);
  // Two directions: a well-formed media door is accepted against the same real
  // rows, so the refusal is about the door and not about refusing.
  assert.equal(mediaDoorRefusal({ mediaDoor: `http://${'b'.repeat(56)}.onion`, rows: EGRESS }), '');
  assert.equal(mediaDoorRefusal({ mediaDoor: `https://${'b'.repeat(16)}.onion`, rows: EGRESS }), '');
  // And the fixture shape production never produces behaves the same, so the
  // old case is not silently inverted by the predicate change.
  assert.equal(mediaDoorRefusal({ mediaDoor: 'https://media.example', rows: FOUNDER_MEDIA_ROWS }), MEDIA_REFUSAL);
  assert.equal(mediaDoorRefusal({ mediaDoor: `http://${'b'.repeat(56)}.onion`, rows: FOUNDER_MEDIA_ROWS }), '');
});

test('an unset media door is not refused, and the desktop build takes its usual path', () => {
  // Unset is the shipped state: the media host does not exist yet. The door is
  // optional here, so an unset one builds — and the clear fallback is named out
  // loud by vite.config.js rather than left silent. Requiring it would make
  // every desktop build impossible today, which is a product call and is on
  // the founder's card.
  const mediaRows = EGRESS.filter((row) => row.role === 'Media host');
  assert.equal(mediaRows.length, 3);
  assert.equal(mediaDoorRefusal({ mediaDoor: '', rows: EGRESS }), '');

  // And end to end, on the script itself: with a valid group door and no media
  // door, the media check says nothing and the build goes on to run (and here
  // fails only because there is no vite in the fixture folder).
  const dir = workspace();
  try {
    const result = run(dir, { VITE_GROUP_ONION: `wss://${'a'.repeat(56)}.onion` });
    assert.equal(/VITE_MEDIA_ONION/.test(result.stderr), false,
      'the media refusal must not fire while no media row ships the founder host');
    assert.notEqual(result.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Two doors are two build inputs. A record that named only the group door
// would call a bundle with a media door and one without the same bundle, and
// neither the address nor a copy of it belongs in a file that gets carried
// around, so each door is recorded as a hash.
test('the build record names both doors by hash, and two media doors are two records', () => {
  const dir = workspace();
  const group = `wss://${'a'.repeat(56)}.onion`;
  const media = `http://${'b'.repeat(56)}.onion`;
  try {
    const dark = manifestFor(dir, { group, media: '' });
    const lit = manifestFor(dir, { group, media });
    // These lines are what hold the record: `doorSha256` must still be the
    // group door's hash and `mediaDoorSha256` must exist as its own. If the
    // record ever goes back to covering one door, this test fails.
    assert.match(dark.doorSha256, /^[0-9a-f]{64}$/);
    assert.match(dark.mediaDoorSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(dark.doorSha256, dark.mediaDoorSha256, 'two different doors hash differently');
    assert.equal(dark.doorSha256, lit.doorSha256, 'the group door did not change');
    assert.notEqual(dark.mediaDoorSha256, lit.mediaDoorSha256, 'the media door did');
    assert.equal(dark.mediaDoorSha256, manifestFor(dir, { group, media: '' }).mediaDoorSha256);

    // Neither address, nor any prefix of one, is in the record.
    const record = JSON.stringify(dark);
    assert.equal(record.includes('.onion'), false);
    assert.equal(record.includes('b'.repeat(16)), false);
    assert.equal(JSON.stringify(lit).includes(media), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a build that cannot run fails without writing a manifest over the old output', () => {
  const dir = workspace();
  try {
    // A valid door, an untracked build file, and no vite to run: the child
    // fails the way a broken build does, and the stale folder must not come
    // out of it looking fresh.
    fs.mkdirSync(path.join(dir, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.grok', 'app-env.json'), JSON.stringify({ VITE_GROUP_ONION: `wss://${'a'.repeat(56)}.onion` }));
    const result = run(dir);
    assert.notEqual(result.status, 0);
    assert.equal(manifest(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

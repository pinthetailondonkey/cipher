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

// The media door's refusal, in two directions. A refusal tested only in the
// direction that can fire today would be half a proof, and today the direction
// that fires does not exist yet: no media row ships the founder's host, so the
// check is inert by design. The fixture row below is what stands in for the
// day that literal lands, and it is exercised here rather than described.
const FOUNDER_MEDIA_ROWS = [
  { id: 'blossom-primal', role: 'Media host', url: 'https://media.example', gate: 'founder' },
  { id: 'blossom-nostr-build', role: 'Media host', url: 'https://media.example', gate: 'founder' },
  { id: 'blossom-band', role: 'Media host', url: 'https://media.example', gate: 'founder' },
];

test('a build shipping the founder media host without a media onion is refused', () => {
  assert.equal(mediaDoorRefusal({ mediaDoor: '', rows: FOUNDER_MEDIA_ROWS }), MEDIA_REFUSAL);
  assert.equal(mediaDoorRefusal({ mediaDoor: 'https://media.example', rows: FOUNDER_MEDIA_ROWS }), MEDIA_REFUSAL);
  // The same rows with a real onion are accepted — the refusal is about the
  // door, not about refusing.
  assert.equal(mediaDoorRefusal({ mediaDoor: `http://${'b'.repeat(56)}.onion`, rows: FOUNDER_MEDIA_ROWS }), '');
});

test("today's rows ship no founder media host, so the desktop build is unchanged", () => {
  // The measured state of the shipped rows, not a claim about them: until the
  // founder's media host lands, no media row carries the marker, so the
  // refusal cannot fire and the build takes the path it always took.
  const mediaRows = EGRESS.filter((row) => row.role === 'Media host');
  assert.equal(mediaRows.length, 3);
  assert.equal(mediaRows.every((row) => row.gate !== 'founder'), true,
    'no media row ships the founder host yet, so the media refusal stays inert');
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

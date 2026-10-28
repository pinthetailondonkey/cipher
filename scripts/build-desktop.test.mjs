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

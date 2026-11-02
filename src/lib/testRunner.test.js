// Every test file under src/ and scripts/ has a runner, and every path named in
// `npm test` still exists.
//
// Why this exists: `npm test` is an explicit file list, not a glob, so a new
// `*.test.js` is invisible until someone remembers to add it, and a renamed
// file leaves a stale path that node turns into a silent "0 tests". Phase 0 of
// the launch log found ten files in exactly that state, including five of the
// six escrow files, and the fix was by hand with nothing left to keep it true.
// This is the thing that keeps it true.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKIP = new Set(['node_modules', '.git', 'dist', '.vercel', 'android', '.claude', 'desktop']);

const listOnDisk = (dir, out = []) => {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) listOnDisk(rel, out);
    else if (/\.test\.(js|mjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
};

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const listed = new Set(pkg.scripts.test.match(/[\w./-]+\.test\.(js|mjs)/g) ?? []);

test('every test file under src/ and scripts/ is named in `npm test`', () => {
  const orphans = [...listOnDisk('src'), ...listOnDisk('scripts')].filter((f) => !listed.has(f));
  assert.deepEqual(orphans, [],
    `add these to the test script: ${orphans.join(', ')}`);
});

test('every path named in `npm test` exists on disk', () => {
  const missing = [...listed].filter((f) => !existsSync(join(ROOT, f)));
  assert.deepEqual(missing, [],
    `these test paths are gone or renamed: ${missing.join(', ')}`);
});

test('the guard covers a real set, not an empty walk', () => {
  // If a glob above silently stopped matching, both arms would pass vacuously.
  assert.ok(listed.size > 100, `expected the suite to name >100 files, saw ${listed.size}`);
  assert.ok(listOnDisk('src').length > 100, 'expected >100 test files under src/');
  assert.equal(relative(ROOT, ROOT), '');
});

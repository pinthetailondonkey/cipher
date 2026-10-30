import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// The guard in vite.config.js is what keeps the test seam and the test relay
// wall out of a build that ships. Every other test in this repo drives Vite
// with `configFile: false`, so none of them has ever loaded that guard — which
// means nothing has ever proved it answers the question Vite asks.
//
// It did not. The guard read process.env, and Vite never puts .env.local there:
// it inlines .env.local into import.meta.env at transform time. An untracked
// .env.local carrying VITE_TEST_HOOKS=1 therefore crossed the guard silently
// and shipped a bundle pointing at this machine. These tests build with the
// REAL config and a temporary .env.local, because the file is the whole
// question: a guard that is asked the right question refuses it, and one that
// is asked process.env does not.
//
// Each test cleans up in a finally block. The tree must have no env file of
// its own before this runs: writing over someone's .env.local would be a worse
// bug than the one under test, so the precondition fails loudly instead.

const TREE = new URL('..', import.meta.url).pathname;
const ENV_LOCAL = join(TREE, '.env.local');
const VITE = join(TREE, 'node_modules/vite/bin/vite.js');
const WALL_WS = 'ws://127.0.0.1:9';
const WALL_HTTP = 'http://127.0.0.1:9';

// Nothing from the surrounding shell may reach the build: every case below
// supplies its own answer, and an inherited flag would blur which one won.
function cleanEnv() {
  const env = { ...process.env };
  delete env.VITE_TEST_HOOKS;
  delete env.CIPHER_UI_TEST_BUILD;
  return env;
}

// Exactly the names Vite reads for a production build, and no pattern wider
// than that. The tree ships an .env.example — a template for the watcher box —
// and it is inert: Vite never reads it. A precondition that tripped on every
// .env* file would make this suite unrunnable on the shipped tree while proving
// nothing extra, which is a worse failure than the one being tested.
const VITE_ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];

function assertPristineEnv() {
  const stray = VITE_ENV_FILES.filter((name) => existsSync(join(TREE, name)));
  assert.deepEqual(stray, [], `the tree already has ${stray.join(', ')}; refusing to run with a foreign env file`);
}

function builtText(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(builtText(full));
    else if (/\.(js|mjs)$/.test(name)) out.push(readFileSync(full, 'utf8'));
  }
  return out.join('\n');
}

function build({ fileLines = null, env = cleanEnv() } = {}) {
  assertPristineEnv();
  assert.equal(existsSync(ENV_LOCAL), false, 'a .env.local exists; refusing to overwrite it');
  const outDir = mkdtempSync(join(TREE, '.guard-build-'));
  try {
    if (fileLines) writeFileSync(ENV_LOCAL, `${fileLines.join('\n')}\n`);
    const run = spawnSync(process.execPath, [VITE, 'build', '--outDir', outDir], {
      cwd: TREE, env, encoding: 'utf8',
    });
    return { status: run.status, stderr: run.stderr || '', stdout: run.stdout || '', text: builtText(outDir) };
  } finally {
    rmSync(ENV_LOCAL, { force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}

test('a .env.local that turns the test hooks on is refused, not built', () => {
  const run = build({ fileLines: ['VITE_TEST_HOOKS=1'] });
  // The refusal has to happen, and it has to happen for the stated reason: a
  // build that fails for any other reason would satisfy "not 0" while leaving
  // the hole open.
  assert.notEqual(run.status, 0, 'a .env.local carrying VITE_TEST_HOOKS built a bundle');
  assert.match(run.stderr, /vite refuses: VITE_TEST_HOOKS is set without CIPHER_UI_TEST_BUILD/);
  assert.equal(run.text.includes(WALL_WS), false, 'a refused build still wrote the wall to disk');
});

test('the same .env.local builds when the build also says it is a test build', () => {
  // The control. Without it the test above could pass for the trivial reason
  // that no .env.local is ever read at all — and the failure being guarded
  // against is precisely that one IS read, by Vite, if not by the guard.
  const run = build({ fileLines: ['VITE_TEST_HOOKS=1', 'CIPHER_UI_TEST_BUILD=1'] });
  assert.equal(run.status, 0, `the deliberate test build failed:\n${run.stderr.slice(-2000)}`);
  assert.ok(run.text.includes(WALL_WS) || run.text.includes(WALL_HTTP),
    'the test build did not carry the wall, so this control proves nothing');
});

test('the flag in the process environment is refused too, so one answer covers both doors', () => {
  const run = build({ env: { ...cleanEnv(), VITE_TEST_HOOKS: '1' } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /vite refuses: VITE_TEST_HOOKS is set without CIPHER_UI_TEST_BUILD/);
});

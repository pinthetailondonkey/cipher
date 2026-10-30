import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// The refusals in vite.config.js are what keep a build that ships from
// carrying the test seam, the test relay wall, or a door address. Every other
// test in this repo drives Vite with `configFile: false`, so none of them has
// ever loaded that config — nothing proved the guards answer the question Vite
// actually asks.
//
// They did not. The guard read process.env, and Vite never puts an env file
// there: it inlines .env.local into import.meta.env at transform time. A
// .env.local carrying VITE_TEST_HOOKS=1 crossed it silently and built a bundle
// pointing at this machine. The same shape applied to the doors: a
// VITE_GROUP_ONION in the environment is replaced into the bundle as text, so
// the onion lands in a public file even though the app resolves that row to
// the clear address. Every behaviour check says "clearnet" while the address
// sits in the bytes.
//
// So these tests build through the REAL config, and the ones that can pass
// assert on the produced bytes rather than on a resolved value.

const TREE = new URL('..', import.meta.url).pathname;
const ENV_LOCAL = join(TREE, '.env.local');
const VITE = join(TREE, 'node_modules/vite/bin/vite.js');

// A fabricated door. It is a well-formed onion literal and it is nobody's
// address: what is being tested is whether a door survives into a bundle, and
// a real one would be the leak.
const FIXTURE_DOOR = 'wss://fixturedoorfixturedoor.onion';
const ONION_LITERAL = /[a-z2-7]{16,56}\.onion/;
const WALL_WS = 'ws://127.0.0.1:9';
const WALL_HTTP = 'http://127.0.0.1:9';

// Nothing from the surrounding shell may reach the build: every case supplies
// its own answer, and an inherited flag would blur which one won.
function cleanEnv() {
  const env = { ...process.env };
  for (const key of ['VITE_TEST_HOOKS', 'CIPHER_UI_TEST_BUILD', 'CIPHER_DESKTOP_BUILD',
    'VITE_GROUP_ONION', 'VITE_MEDIA_ONION']) delete env[key];
  return env;
}

// Exactly the names Vite reads for a production build, and no pattern wider
// than that. The tree ships an .env.example — a template for the watcher box —
// and it is inert: Vite never reads it. A precondition that tripped on every
// .env* file would make this suite unrunnable on the shipped tree while proving
// nothing extra, which is a worse failure than the one being tested.
const VITE_ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];

function assertPristineEnv({ allowCarrier = false } = {}) {
  const stray = VITE_ENV_FILES.filter((name) => existsSync(join(TREE, name)));
  assert.deepEqual(stray, [], `the tree already has ${stray.join(', ')}; refusing to run with a foreign env file`);
  if (allowCarrier) return;
  assert.equal(existsSync(join(TREE, '.grok', 'app-env.json')), false,
    'the tree has a .grok/app-env.json; a non-desktop build refuses on it, so this suite cannot run beside one');
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

function build({ fileLines = null, env = cleanEnv(), allowCarrier = false } = {}) {
  assertPristineEnv({ allowCarrier });
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

test('a .env.local is refused by its presence, before its contents are read', () => {
  // Red first, before this refusal existed: with VITE_TEST_HOOKS=1 in this
  // file a plain build exited 0 and the bundle carried the test relay wall.
  const flagged = build({ fileLines: ['VITE_TEST_HOOKS=1'] });
  assert.notEqual(flagged.status, 0, 'a .env.local carrying VITE_TEST_HOOKS built a bundle');
  assert.match(flagged.stderr, /vite refuses: \.env\.local is present/);
  assert.equal(flagged.text.includes(WALL_WS), false, 'a refused build still wrote the wall to disk');

  // And the rule is presence, not content: a file with nothing in it that this
  // build cares about is refused for the same reason, because the next value
  // someone adds is the one that matters and nobody would re-read this test.
  const harmless = build({ fileLines: ['SHOP_UNRELATED=1'] });
  assert.notEqual(harmless.status, 0, 'a .env.local built a bundle, so the rule is content-dependent');
  assert.match(harmless.stderr, /vite refuses: \.env\.local is present/);
});

test('the deliberate test build still builds, and its bytes carry the wall and no door', () => {
  // The control. Without it the refusals above could pass for the trivial
  // reason that no build ever succeeds — and the failure being guarded against
  // is precisely that the flag DOES reach the bundle when the build says it
  // means to.
  const run = build({ env: { ...cleanEnv(), VITE_TEST_HOOKS: '1', CIPHER_UI_TEST_BUILD: '1' } });
  assert.equal(run.status, 0, `the deliberate test build failed:\n${run.stderr.slice(-2000)}`);
  assert.ok(run.text.includes(WALL_WS) || run.text.includes(WALL_HTTP),
    'the test build did not carry the wall, so this control proves nothing');
  assert.equal(ONION_LITERAL.test(run.text), false, 'a build that ships carried an onion address');
});

test('the workspace build-flag carrier is refused in a build that is not desktop', () => {
  // .grok/app-env.json is merged into the environment by
  // scripts/with-app-env.mjs, so a value in it reaches any build run from this
  // tree — including one that ships. It is how a desktop build is meant to be
  // given its doors, and a desktop build is the only one allowed to carry it.
  const grok = join(TREE, '.grok');
  const carrier = join(grok, 'app-env.json');
  assert.equal(existsSync(carrier), false, 'a .grok/app-env.json already exists; refusing to overwrite it');
  mkdirSync(grok, { recursive: true });
  try {
    writeFileSync(carrier, '{"VITE_TEST_HOOKS":"1"}\n');
    const run = build({ env: { ...cleanEnv(), VITE_TEST_HOOKS: '1', CIPHER_UI_TEST_BUILD: '1' }, allowCarrier: true });
    assert.notEqual(run.status, 0, 'a non-desktop build accepted the workspace flag carrier');
    assert.match(run.stderr, /vite refuses: \.grok\/app-env\.json is present and this is not a desktop build/);
    assert.equal(run.text.includes(WALL_WS), false, 'a refused build still wrote the wall to disk');
  } finally {
    rmSync(carrier, { force: true });
    rmSync(grok, { recursive: true, force: true });
  }
});

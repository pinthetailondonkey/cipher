import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TEST_RELAY_OVERRIDE, TEST_RELAY_OVERRIDE_MARK } from './testRelayOverride.js';

// The pair that makes the test relay wall safe to exist.
//
// The failure this prevents is not "the override is wrong" — it is "the
// override reaches a build that ships". So both halves are measured on a real
// bundle made by the same Vite the npm scripts use:
//
//   1. no flag  → every called row resolves to the address in its own row, and
//                 the bundle carries neither the wall's addresses nor its mark;
//   2. flag set → every covered row resolves to this machine, and the bundle
//                 carries the wall.
//
// Nothing here dials anything and no hostname is named: the wall's addresses
// are loopback, and the shipped ones are compared by identity against the
// module's own rows rather than against a list written here.

const TREE = new URL('../..', import.meta.url).pathname;
const WALL = '127.0.0.1:9';

const PROBE = `
import { EGRESS, activeUrl } from ${JSON.stringify(join(TREE, 'src/lib/egress.js'))};
const empty = { overrides: {}, lists: { profile: [], dm: [] } };
const rows = EGRESS.filter((row) => row.called !== false && !row.dynamic && row.url)
  .map((row) => ({ id: row.id, shipped: row.url, active: activeUrl(row, empty) }));
process.stdout.write(JSON.stringify(rows));
`;

async function bundle(extraEnv) {
  const { build } = await import(join(TREE, 'node_modules/vite/dist/node/index.js'));
  const dir = mkdtempSync(join(tmpdir(), 'relay-wall-'));
  const entry = join(dir, 'probe.mjs');
  writeFileSync(entry, PROBE);
  const outDir = join(dir, 'out');
  const saved = { ...process.env };
  for (const key of ['VITE_TEST_HOOKS', 'CIPHER_UI_TEST_BUILD', 'CIPHER_DESKTOP_BUILD']) delete process.env[key];
  Object.assign(process.env, extraEnv);
  try {
    await build({
      configFile: false,
      root: TREE,
      cacheDir: join(dir, '.vite'),
      logLevel: 'silent',
      build: {
        ssr: entry,
        outDir,
        emptyOutDir: true,
        minify: false,
        rollupOptions: { output: { format: 'cjs', entryFileNames: 'probe.cjs' } },
      },
      define: { __CIPHER_DESKTOP_BUILD__: 'false' },
    });
  } finally {
    process.env = saved;
  }
  const text = readFileSync(join(outDir, 'probe.cjs'), 'utf8');
  // The rows come from running the bundle, not from reading it: what is
  // asserted is what the built code resolves, and the source text is a
  // separate question (what the bundle does and does not carry).
  const rows = JSON.parse(execFileSync(process.execPath, [join(outDir, 'probe.cjs')], { encoding: 'utf8' }));
  rmSync(dir, { recursive: true, force: true });
  return { rows, text };
}

test('a build that ships resolves every row to its own address, and carries no wall', async () => {
  const { rows, text } = await bundle({});
  // Absent, not merely unused: the address the wall dials is a literal no
  // shipping bundle can carry, and neither is the mark that names the module.
  // Asserted before the rows so a leak is reported as a leak.
  assert.equal(text.includes(WALL), false, 'the shipping bundle carries the wall addresses');
  assert.equal(text.includes(TEST_RELAY_OVERRIDE_MARK), false, 'the shipping bundle carries the wall module');
  assert.ok(rows.length >= 13, `expected the called rows, measured ${rows.length}`);
  for (const row of rows) {
    assert.equal(row.active, row.shipped, `${row.id} must resolve to its own row in a build that ships`);
  }
});

test('a UI-test build resolves every covered row to this machine and nothing else', async () => {
  const { rows, text } = await bundle({ VITE_TEST_HOOKS: '1', CIPHER_UI_TEST_BUILD: '1' });
  const covered = Object.keys(TEST_RELAY_OVERRIDE).sort();
  assert.deepEqual(rows.map((row) => row.id).sort(), covered, 'the rows the wall covers are exactly the called rows');
  for (const row of rows) {
    assert.equal(new URL(row.active).hostname, '127.0.0.1', `${row.id} must resolve to this machine`);
    assert.equal(row.active.includes(WALL), true, `${row.id} must resolve to the wall's own port`);
    assert.notEqual(row.active, row.shipped, `${row.id} must not keep its shipped address in a test build`);
  }
  assert.equal(text.includes(WALL), true, 'the UI-test bundle does not carry the wall addresses');
});

// Pinned IETF/OpenMLS 0.9.2 test-vector run driver (plan item 18, spec
// Section 9).
//
// What this does, in order:
//   1. Verifies every vendored vector file in test-vectors/ietf-mls-0.9.2-cs1/
//      against the sha256 recorded in its manifest.json (byte-level tamper
//      check of the pins themselves), and verifies the manifest's counts.
//   2. Runs the Rust-side aggregate via `cargo test --test pinned_vectors`
//      against crypto/mls-wasm (native target). The cargo test asserts exact
//      per-family CHECKED/SKIPPED counts and fails loudly on any drift.
//
// It deliberately re-executes the cargo tests instead of trying to embed the
// runner: the wasm/nativesplit is documented in crypto/mls-wasm/src/
// pinned_vectors.rs and the npm layer stays a thin, honest orchestrator.
//
// Evidence tier: LOCAL-TEST ONLY. Passing here does NOT claim interop with
// other MLS implementations; that needs the separate IETF interop client
// work (tracked separately).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vectorsDir = path.join(root, 'test-vectors', 'ietf-mls-0.9.2-cs1');
const manifest = JSON.parse(readFileSync(path.join(vectorsDir, 'manifest.json'), 'utf8'));

let failures = 0;
const fail = (...lines) => {
  failures += 1;
  for (const line of lines) console.error(`FAIL: ${line}`);
};

// --- 1. manifest integrity -------------------------------------------------

for (const [file, entry] of Object.entries(manifest.files)) {
  const full = path.join(vectorsDir, file);
  let bytes;
  try {
    bytes = readFileSync(full);
  } catch (error) {
    fail(`vendored vector file missing: ${file} (${error.message})`);
    continue;
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== entry.sha256) {
    fail(`${file}: sha256 mismatch\n  expected ${entry.sha256}\n  got      ${digest}`);
    continue;
  }
  const parsed = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(parsed) || parsed.length !== entry.count) {
    fail(
      `${file}: count mismatch (manifest says ${entry.count}, file has ${
        Array.isArray(parsed) ? parsed.length : typeof parsed
      })`,
    );
  }
}

if (!Array.isArray(manifest.files) && typeof manifest.files !== 'object') {
  fail('manifest.json has no files object');
}

console.log(`manifest integrity: ${Object.keys(manifest.files).length} files checked`);

// --- 2. rust aggregate run -----------------------------------------------

execFileSync('cargo', ['test', '--locked', '--test', 'pinned_vectors'], {
  cwd: path.join(root, 'crypto', 'mls-wasm'),
  stdio: 'inherit',
});
console.log('cargo pinned_vectors: pass');

if (failures > 0) {
  console.error(`run-mls-vectors: ${failures} failure(s); nothing silently passes.`);
  process.exitCode = 1;
} else {
  console.log(
    'Pinned OpenMLS/IETF MLS 0.9.2 CS1 vectors: all runnable families green '
      + '(secret-tree/treekem skipped loudly upstream; see FamilyResult reasons).',
  );
}

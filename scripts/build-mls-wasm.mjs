import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(root, 'crypto', 'mls-wasm', 'Cargo.toml');
const wasm = path.join(root, 'crypto', 'mls-wasm', 'target', 'wasm32-unknown-unknown', 'release', 'cipher_openmls_wasm_smoke.wasm');
const output = path.join(root, 'crypto', 'mls-wasm', 'target', 'browser-bindings');
const expectedBindgen = 'wasm-bindgen 0.2.128';

const bindgenVersion = execFileSync('wasm-bindgen', ['--version'], { encoding: 'utf8' }).trim();
if (bindgenVersion !== expectedBindgen) {
  throw new Error(`Expected ${expectedBindgen}; got ${bindgenVersion}. Install the pinned CLI for reproducible bindings.`);
}

execFileSync('cargo', ['build', '--locked', '--manifest-path', manifest, '--target', 'wasm32-unknown-unknown', '--release'], {
  cwd: root,
  stdio: 'inherit',
});
if (!existsSync(wasm)) throw new Error('The OpenMLS evaluation WASM build did not produce its expected module.');
mkdirSync(output, { recursive: true });
execFileSync('wasm-bindgen', [wasm, '--target', 'web', '--out-dir', output, '--out-name', 'cipher_mls_eval'], {
  cwd: root,
  stdio: 'inherit',
});

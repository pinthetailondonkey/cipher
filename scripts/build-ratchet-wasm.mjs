import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(root, 'crypto', 'ratchet-wasm', 'Cargo.toml');
const wasm = path.join(root, 'crypto', 'ratchet-wasm', 'target', 'wasm32-unknown-unknown', 'release', 'cipher_ratchet_wasm.wasm');
const output = path.join(root, 'src', 'lib', 'ratchet', 'wasm');
const expectedBindgen = 'wasm-bindgen 0.2.128';

const bindgenVersion = execFileSync('wasm-bindgen', ['--version'], { encoding: 'utf8' }).trim();
if (bindgenVersion !== expectedBindgen) {
  throw new Error(`Expected ${expectedBindgen}; got ${bindgenVersion}. Install the pinned CLI to keep generated bindings reproducible.`);
}

execFileSync('cargo', ['build', '--locked', '--manifest-path', manifest, '--target', 'wasm32-unknown-unknown', '--release'], {
  cwd: root,
  stdio: 'inherit',
});
if (!existsSync(wasm)) throw new Error('The ratchet WASM build did not produce its expected module.');
mkdirSync(output, { recursive: true });
execFileSync('wasm-bindgen', [wasm, '--target', 'web', '--out-dir', output, '--out-name', 'cipher_ratchet_wasm'], {
  cwd: root,
  stdio: 'inherit',
});

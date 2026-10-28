// After electron-builder has packed the app: prove the archive actually
// carries what prepare-pack checked, and not what a browser test build does.
//
//   node scripts/verify-asar.mjs [asarPath]
//
// prepare-pack checks desktop/web before packing. That is one folder and one
// moment; the asar is what ships. An asar stores each packed file's bytes
// verbatim after a JSON header, so the two things worth failing on can be
// read straight out of the archive without unpacking it:
//   - the test seam (`__cipher`), which reaches storage and identity from the
//     console and must not be in a shipping bundle;
//   - the build manifest's source commit, so the archive can be traced to a
//     SHA instead of to whenever it was built.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CANDIDATES = [
  'out/linux-unpacked/resources/app.asar',
  'out/win-unpacked/resources/app.asar',
  'out/mac/Cipher.app/Contents/Resources/app.asar',
];

export function verifyAsar(asarPath, { expectedSha } = {}) {
  const bytes = fs.readFileSync(asarPath);
  const text = bytes.toString('latin1');
  if (text.includes('__cipher')) {
    throw new Error(`${asarPath} carries the test seam (__cipher). That build can reach the vault from the console; rebuild it with "npm run build:desktop" before packing.`);
  }
  if (/cipher-desktop-build\.json/.test(text) === false) {
    throw new Error(`${asarPath} has no build manifest inside it, so it cannot be traced to a source commit.`);
  }
  const want = String(expectedSha || '').trim();
  if (want && !text.includes(want)) {
    throw new Error(`${asarPath} does not carry the source commit ${want.slice(0, 12)}; it is stale or from another tree.`);
  }
  return { asarPath, bytes: bytes.length, expectedSha: want || null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const given = process.argv[2];
    const asarPath = given ? path.resolve(given) : CANDIDATES.map((p) => path.join(root, p)).find((p) => fs.existsSync(p));
    if (!asarPath) throw new Error(`No packed app.asar found. Build first, then run this, or pass the path: node scripts/verify-asar.mjs <app.asar>`);
    const result = verifyAsar(asarPath, { expectedSha: process.env.CIPHER_EXPECT_SHA });
    console.log(`Checked ${path.relative(root, result.asarPath)}: no test seam, manifest present${result.expectedSha ? `, source ${result.expectedSha.slice(0, 12)}` : ''}.`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

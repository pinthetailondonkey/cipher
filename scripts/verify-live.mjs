// Proves a deploy by the page, never by a status code.
//
// The live host answered 200 for three days while serving a build from four
// days earlier, so a status code says nothing. What does say something: the
// name of the bundle the page loads. Vite names its entry after the content,
// so a page carrying the same name as a local build of this commit is
// running this commit.
//
// A name is still only a name tag: anyone who can push a deploy can copy a
// name onto different bytes. So the proof goes one step further and compares
// a fingerprint of the served bytes against this tree's build. A stale build
// fails on the name; a tampered one under a copied name fails on the bytes.
//
//   npm run verify:live                      the canonical address
//   npm run verify:live -- https://host      any host
//   npm run verify:live -- --skip-build      reuse the dist already there
//
// Exit 0 when the names and the bytes match, 1 when either does not, 2 when
// the page cannot be read or carries no title.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_URL = 'https://www.ciphermessenger.org';
const ENTRY = /(?:^|\/)assets\/(index-[A-Za-z0-9_-]+\.js)/;

const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const target = (args.find((arg) => !arg.startsWith('--')) || process.env.LIVE_URL || DEFAULT_URL).replace(/\/$/, '');

function entryName(html) {
  const match = String(html || '').match(ENTRY);
  return match ? match[1] : '';
}

if (!skipBuild) {
  const built = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' });
  if (built.status !== 0) {
    console.error('verify:live — the local build failed, so there is nothing to compare.');
    process.exit(1);
  }
}

const indexPath = path.resolve('dist', 'index.html');
const built = fs.existsSync(indexPath) ? entryName(fs.readFileSync(indexPath, 'utf8')) : '';
if (!built) {
  console.error(`verify:live — no bundle name in ${indexPath}. Build first.`);
  process.exit(2);
}

// Redirects are followed by hand so each hop is printed. A deploy that
// "passes" because something forwarded the request is only a pass if the
// forwarding is the one that was expected, so the hops have to be visible.
let page = '';
let status = 0;
let url = `${target}/`;
const hops = [];
try {
  for (let hop = 0; hop <= 5; hop += 1) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location') || '';
      hops.push({ from: url, status, to: location });
      if (!location) break;
      url = new URL(location, url).toString();
      continue;
    }
    page = await response.text();
    break;
  }
} catch (error) {
  console.error(`verify:live — ${url} could not be read: ${error?.cause?.code || error.message}`);
  process.exit(2);
}

const title = (page.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
const live = entryName(page);

console.log(`verify:live — ${target}`);
for (const hop of hops) console.log(`  redirect    ${hop.status} ${hop.from} -> ${hop.to || '(no location)'}`);
console.log(`  final       ${url}`);
console.log(`  status      ${status}`);
console.log(`  title       ${title || '(none)'}`);
console.log(`  built here  ${built}`);
console.log(`  served      ${live || '(none)'}`);

if (title !== 'Cipher') {
  console.error('verify:live — the page does not carry the Cipher title.');
  process.exit(2);
}
if (live !== built) {
  console.error(`verify:live — the live page is not this build. It serves ${live || 'nothing'}, this tree builds ${built}.`);
  process.exit(1);
}

// The names matching is only half a proof: a name is a label anyone holding
// the deploy account can copy onto different bytes. The proof is complete
// when the served file's fingerprint equals this tree's. The body is read
// through arrayBuffer(), which returns the bytes after the transport
// compression is undone, so a host's gzip choice cannot change the answer.
const fingerprint = (bytes) => createHash('sha256').update(bytes).digest('hex');
let servedFingerprint = '';
try {
  const served = await fetch(new URL(`assets/${live}`, url), { signal: AbortSignal.timeout(20000) });
  if (!served.ok) {
    console.error(`verify:live — the live bundle answered ${served.status}, so its bytes cannot be proven.`);
    process.exit(2);
  }
  servedFingerprint = fingerprint(new Uint8Array(await served.arrayBuffer()));
} catch (error) {
  console.error(`verify:live — the live bundle could not be read for fingerprinting: ${error?.cause?.code || error.message}`);
  process.exit(2);
}
const localBundle = path.resolve('dist', 'assets', built);
if (!fs.existsSync(localBundle)) {
  console.error(`verify:live — ${localBundle} is missing, so there are no bytes to compare against.`);
  process.exit(2);
}
const localFingerprint = fingerprint(new Uint8Array(fs.readFileSync(localBundle)));
console.log(`  served sha  ${servedFingerprint.slice(0, 16)}`);
console.log(`  built sha   ${localFingerprint.slice(0, 16)}`);
if (servedFingerprint !== localFingerprint) {
  console.error('verify:live — the live bundle wears this build\'s name but not its bytes. Tampered, or built by a different toolchain.');
  process.exit(1);
}

// A bundle that matches is only half a proof. The service worker caches from
// dist/asset-manifest.json, which `npm run build` writes separately from the
// bundle — a bare `vite build` produces the SAME bundle name and SAME bytes
// but never writes the manifest. A deploy like that would pass the check
// above while the app cannot open offline. So the proof also fetches the
// manifest and checks it names the assets this tree's build produced.
const manifestPath = new URL('asset-manifest.json', url);
let manifestOk = false;
let servedManifest = '';
try {
  const manifestResponse = await fetch(manifestPath, { signal: AbortSignal.timeout(20000) });
  if (manifestResponse.ok) {
    servedManifest = await manifestResponse.text();
    const listed = JSON.parse(servedManifest);
    const files = new Set(Array.isArray(listed?.files) ? listed.files : []);
    manifestOk = files.size > 0 && files.has(`/assets/${live}`);
  } else {
    console.error(`verify:live — the live asset-manifest.json answered ${manifestResponse.status}.`);
  }
} catch (error) {
  console.error(`verify:live — the live asset-manifest.json could not be read: ${error?.cause?.code || error.message}`);
}
const localManifestPath = path.resolve('dist', 'asset-manifest.json');
let localManifestOk = false;
if (fs.existsSync(localManifestPath)) {
  try {
    const local = JSON.parse(fs.readFileSync(localManifestPath, 'utf8'));
    localManifestOk = Array.isArray(local?.files) && local.files.includes(`/assets/${built}`);
  } catch {
    localManifestOk = false;
  }
}
console.log(`  manifest    ${manifestOk ? 'present, names the entry' : 'missing or does not name the entry'}`);
if (!localManifestOk) {
  console.error('verify:live — this tree\'s build wrote no asset-manifest.json, so there is nothing to compare against. Run the full build.');
  process.exit(2);
}
if (!manifestOk) {
  console.error('verify:live — the live deploy does not serve an asset-manifest.json naming this build\'s entry. The app cannot open offline on that deploy.');
  process.exit(1);
}

console.log('verify:live — the live page is this build, down to the bytes, and the offline manifest matches.');

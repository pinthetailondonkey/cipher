// Proves a deploy by the page, never by a status code.
//
// The live host answered 200 for three days while serving a build from four
// days earlier, so a status code says nothing. What does say something: the
// name of the bundle the page loads. Vite names its entry after the content,
// so a page carrying the same name as a local build of this commit is
// running this commit.
//
//   npm run verify:live                      the canonical address
//   npm run verify:live -- https://host      any host
//   npm run verify:live -- --skip-build      reuse the dist already there
//
// Exit 0 when the names match, 1 when they do not, 2 when the page cannot be
// read or carries no title.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_URL = 'https://ciphermessenger.org';
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
console.log('verify:live — the live page is this build.');

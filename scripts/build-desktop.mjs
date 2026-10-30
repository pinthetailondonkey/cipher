#!/usr/bin/env node
// The build the desktop shell packages: the ordinary web build plus the onion
// group door, because the shell runs its own Tor and a browser cannot reach an
// onion at all. It writes to dist-desktop so it can never overwrite the web
// build that becomes production; prepare-pack stages this folder and refuses
// a folder this script did not write.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAppEnv } from './with-app-env.mjs';
import { EGRESS } from '../src/lib/egress.js';

// The media door's shape, refused here for the same reason the group door is:
// a set-but-cleartext media door points the desktop build's pictures at a
// clear host, so the media leaves Tor while every row still renders.
//
// The predicate reads the rows that actually ship. An earlier version required
// `gate: 'founder'` on a media row before it would look at the door at all, and
// no shipped row carries that field — so the check was inert against the real
// EGRESS, and the test that appeared to cover it built its own three-row
// fixture carrying a shape production never produces. A predicate and its data
// can disagree for as long as the test invents its own data; that term is gone.
//
// The door stays optional here, deliberately. The media host does not exist
// yet, and a required door would make every desktop build impossible today
// while the rows' fallback is a clear host either way. What is refused is a
// door that is present and wrong. Whether a desktop build should be allowed
// without one at all is a product decision, not this script's: it is named on
// the founder's card rather than decided in a comment.
export const MEDIA_REFUSAL = 'build:desktop refuses: VITE_MEDIA_ONION is set but is not an onion address. The desktop media would leave Tor for whatever host that names. Set it in .grok/app-env.json (untracked).';

const MEDIA_ONION = /^https?:\/\/[a-z2-7]{16,56}\.onion$/;

export function mediaDoorRefusal({ mediaDoor, rows }) {
  const mediaRows = (rows || []).some((row) => row.role === 'Media host');
  if (!mediaRows) return '';
  const door = String(mediaDoor || '').trim();
  // Unset is the shipped state and is not refused; Vite warns on it, once,
  // where the build actually runs.
  if (!door) return '';
  return MEDIA_ONION.test(door) ? '' : MEDIA_REFUSAL;
}

// What this build was made from. A marker alone says "a desktop build once
// wrote here"; it cannot tell a fresh build from a stale folder, from a web
// build with a copied marker, or from a build of a different source. The
// manifest below records the source commit and a hash per file, and
// prepare-pack recomputes both before it stages anything.
function git(args) {
  try {
    return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// Every door the build could carry is named here, hashed rather than written
// out: the record says which door was in the bundle without putting an address
// in a file that gets copied around. Both doors are recorded because both are
// build inputs now — one sha and two builds with different media doors are two
// different bundles, and a record naming only the group door could not tell
// them apart.
export function manifestFor(dir, doors = {}) {
  const sha = (value) => createHash('sha256').update(String(value || '')).digest('hex');
  const files = {};
  for (const rel of walk(dir).sort()) {
    if (rel === 'cipher-desktop-build.json') continue;
    files[rel] = createHash('sha256').update(readFileSync(path.join(dir, rel))).digest('hex');
  }
  return {
    desktop: true,
    builtAt: new Date().toISOString(),
    sourceSha: git(['rev-parse', 'HEAD']) || 'no-git',
    sourceDirty: git(['status', '--porcelain', '--untracked-files=no']) !== '',
    doorSha256: sha(doors.group),
    mediaDoorSha256: sha(doors.media),
    files,
  };
}

function main() {
  // Packaging refuses a folder without this manifest, so the manifest is also
  // the only thing that can make an OLD folder look fresh. It is destroyed
  // before anything else runs, which means a build that refuses or falls over
  // leaves its previous output unusable rather than packable: the way to a
  // stageable dist-desktop is a build that finished, at this source.
  rmSync(path.join('dist-desktop', 'cipher-desktop-build.json'), { force: true });

  // The door addresses are not in the repo. A desktop bundle without one would
  // take that traffic off Tor and onto the clear address without a word, so
  // the build refuses instead of falling back. The values come from the
  // untracked build file (.grok/app-env.json) through scripts/with-app-env.mjs.
  const env = readAppEnv(process.cwd());
  const door = String(process.env.VITE_GROUP_ONION || env.VITE_GROUP_ONION || '').trim();
  if (!/^wss:\/\/[a-z2-7]{16,56}\.onion$/.test(door)) {
    console.error('build:desktop refuses: VITE_GROUP_ONION is missing or is not an onion address. The desktop groups would leave Tor. Set it in .grok/app-env.json (untracked).');
    process.exit(1);
  }

  const mediaDoor = String(process.env.VITE_MEDIA_ONION || env.VITE_MEDIA_ONION || '').trim();
  const mediaRefusal = mediaDoorRefusal({ mediaDoor, rows: EGRESS });
  if (mediaRefusal) {
    console.error(mediaRefusal);
    process.exit(1);
  }

  const child = spawn('node', [
    'scripts/with-app-env.mjs', 'vite', '--config', 'vite.config.js', 'build',
    '--outDir', 'dist-desktop', '--emptyOutDir',
  ], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, CIPHER_DESKTOP_BUILD: '1' },
  });

  // The manifest is what prepare-pack asks for. A string search for ".onion"
  // would not do: every bundle carries it in ordinary URL-parsing code, so a web
  // build would pass. A file with the source commit and a hash per built file
  // cannot be mistaken, and cannot be carried over to a different build.
  child.on('exit', (code) => {
    if (code !== 0) {
      process.exit(code ?? 1);
      return;
    }
    const dir = 'dist-desktop';
    if (!statSync(path.join(dir, 'index.html')).isFile()) {
      console.error(`build:desktop: the build finished but wrote no ${dir}/index.html.`);
      process.exit(1);
    }
    const manifest = manifestFor(dir, { group: door, media: mediaDoor });
    writeFileSync(
      path.join(dir, 'cipher-desktop-build.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    console.log(`build:desktop: ${dir}/ written from ${manifest.sourceSha}${manifest.sourceDirty ? ' (dirty tree)' : ''}`);
    process.exit(0);
  });
}

// Imported for its refusal helper (the tests do), the script must not touch a
// dist-desktop folder in whatever directory the import happens from.
const invokedDirectly = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (invokedDirectly) main();

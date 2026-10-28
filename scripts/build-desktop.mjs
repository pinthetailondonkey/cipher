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
import { readAppEnv } from './with-app-env.mjs';

// Packaging refuses a folder without this manifest, so the manifest is also
// the only thing that can make an OLD folder look fresh. It is destroyed
// before anything else runs, which means a build that refuses or falls over
// leaves its previous output unusable rather than packable: the way to a
// stageable dist-desktop is a build that finished, at this source.
rmSync(path.join('dist-desktop', 'cipher-desktop-build.json'), { force: true });

// The group door's address is not in the repo. A desktop bundle without it
// would take groups off Tor and onto the clear address without a word, so the
// build refuses instead of falling back. The value comes from the untracked
// build file (.grok/app-env.json) through scripts/with-app-env.mjs.
const door = String(process.env.VITE_GROUP_ONION || readAppEnv(process.cwd()).VITE_GROUP_ONION || '').trim();
if (!/^wss:\/\/[a-z2-7]{16,56}\.onion$/.test(door)) {
  console.error('build:desktop refuses: VITE_GROUP_ONION is missing or is not an onion address. The desktop groups would leave Tor. Set it in .grok/app-env.json (untracked).');
  process.exit(1);
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

const sourceSha = git(['rev-parse', 'HEAD']) || 'no-git';
const sourceDirty = git(['status', '--porcelain', '--untracked-files=no']) !== '';

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function manifestFor(dir) {
  const files = {};
  for (const rel of walk(dir).sort()) {
    if (rel === 'cipher-desktop-build.json') continue;
    files[rel] = createHash('sha256').update(readFileSync(path.join(dir, rel))).digest('hex');
  }
  return {
    desktop: true,
    builtAt: new Date().toISOString(),
    sourceSha,
    sourceDirty,
    doorSha256: createHash('sha256').update(door).digest('hex'),
    files,
  };
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
  writeFileSync(
    path.join(dir, 'cipher-desktop-build.json'),
    `${JSON.stringify(manifestFor(dir), null, 2)}\n`,
  );
  console.log(`build:desktop: ${dir}/ written from ${sourceSha}${sourceDirty ? ' (dirty tree)' : ''}`);
  process.exit(0);
});

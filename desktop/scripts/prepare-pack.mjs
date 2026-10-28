// Before packing: stage the web build into desktop/web and check the bundled
// tor in vendor/ is the one for the platform being packed.
//
//   node scripts/prepare-pack.mjs linux|win [webBuildDir]
//
// Why a separate folder: electron-builder writes its output next to the app
// and used to pick it up again. The web build was staged into dist/, which
// was also the output folder and also packed (dist/**), so the Windows
// app.asar swallowed the Linux tarball and both unpacked trees. The web
// build now lives in web/, the output goes to out/, and neither is the other.
//
// Why the tor check: fetch-tor.sh and fetch-tor-windows.sh stage into the
// same vendor/tor/ and overwrite each other. Packing with the wrong one
// would ship a bundle whose tor cannot start (and the shell then fails
// closed, so it would be a dead bundle, not a leak).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MANIFEST = 'cipher-desktop-build.json';
const HOOK_MARK = '__cipher';

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// The commit this build claims to come from, read from the checkout that
// holds it. A dist folder copied out of its repo has no answer, and the
// caller must then say which source the pack is for.
export function gitHead(dir) {
  let here = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(here, '.git'))) {
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        return '';
      }
    }
    const up = path.dirname(here);
    if (up === here) return '';
    here = up;
  }
}

// A build is only usable if this script can prove which source it came from,
// that every file in it is the file the build wrote, and that it is the
// desktop target. A marker file proves none of that: it can be copied onto a
// web build, and it survives while the assets beside it go stale.
export function assertDesktopDoor(dir, { expectedSha } = {}) {
  const manifestPath = path.join(dir, MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = null;
  }
  const refuse = (why) => {
    throw new Error(`No group door in the build at ${dir}: ${why}. Run "npm run build:desktop" in the cipher repo root and stage dist-desktop.`);
  };
  if (!manifest || manifest.desktop !== true) refuse('this is a web build, and the desktop would quietly leave Tor for groups');
  if (!manifest.sourceSha || typeof manifest.sourceSha !== 'string') refuse('the build does not say which source it came from');
  if (!manifest.files || typeof manifest.files !== 'object' || !Object.keys(manifest.files).length) {
    refuse('the build records no file list');
  }

  // Every file present must be a file the build wrote, unchanged, and every
  // file the build wrote must still be present. An extra file is a build
  // from somewhere else copied over this one; a hash mismatch is an asset
  // edited after the fact; a missing file is a half-copied folder.
  const onDisk = walk(dir).filter((rel) => rel !== MANIFEST).sort();
  const recorded = Object.keys(manifest.files).sort();
  const missing = recorded.filter((rel) => !onDisk.includes(rel));
  const extra = onDisk.filter((rel) => !recorded.includes(rel));
  if (missing.length) refuse(`the build is missing ${missing.slice(0, 3).join(', ')}`);
  if (extra.length) refuse(`the folder holds files this build did not write (${extra.slice(0, 3).join(', ')})`);
  for (const rel of recorded) {
    if (sha256(path.join(dir, rel)) !== manifest.files[rel]) refuse(`${rel} does not match the build that recorded it`);
  }

  const want = String(expectedSha || '').trim();
  if (!want) refuse('no source commit to check the build against (pass CIPHER_EXPECT_SHA, or stage a folder inside its checkout)');
  if (manifest.sourceSha !== want) refuse(`the build is from ${manifest.sourceSha.slice(0, 12)}, not ${want.slice(0, 12)}`);
  if (manifest.sourceDirty === true) refuse('the build came from a tree with uncommitted changes, so it matches no commit');
  return manifest;
}

// The test seam (VITE_TEST_HOOKS=1) writes `__cipher` globals into the bundle
// so Playwright can drive storage and identity directly. A shipping desktop
// build must not carry it: the seam is a way to reach the vault from the
// console. The web build the shell packages is the same build tested this
// way, so the check belongs here, before anything is staged.
export function assertNoTestHooks(dir) {
  const offenders = [];
  for (const rel of walk(dir)) {
    if (!/\.(js|mjs|cjs|html|css|json|map)$/.test(rel)) continue;
    if (fs.readFileSync(path.join(dir, rel), 'utf8').includes(HOOK_MARK)) offenders.push(rel);
  }
  if (offenders.length) {
    throw new Error(`The build at ${dir} carries the test seam (${offenders.slice(0, 3).join(', ')}): it can reach the vault from the console and must not ship. Rebuild with "npm run build:desktop".`);
  }
}

export function stageWeb(webBuildDir, targetDir, options = {}) {
  if (!fs.existsSync(path.join(webBuildDir, 'index.html'))) {
    throw new Error(`No build at ${webBuildDir}. Run "npm run build:desktop" in the cipher repo root first.`);
  }
  const expectedSha = options.expectedSha
    || process.env.CIPHER_EXPECT_SHA
    || gitHead(webBuildDir);
  assertDesktopDoor(webBuildDir, { expectedSha });
  assertNoTestHooks(webBuildDir);
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(webBuildDir, targetDir, { recursive: true });
}

export function checkVendorTor(vendorDir, platform) {
  const dir = path.join(vendorDir, 'tor', 'tor');
  const have = (n) => fs.existsSync(path.join(dir, n));
  if (platform === 'win') {
    if (!have('tor.exe')) {
      throw new Error('vendor/tor has no tor.exe. Run scripts/fetch-tor-windows.sh first.');
    }
    if (have('tor')) {
      throw new Error('vendor/tor holds a Linux tor beside tor.exe. Re-run scripts/fetch-tor-windows.sh (it replaces vendor/tor whole).');
    }
  } else if (platform === 'linux') {
    if (!have('tor')) {
      throw new Error('vendor/tor has no tor. Run scripts/fetch-tor.sh first.');
    }
    if (have('tor.exe')) {
      throw new Error('vendor/tor holds a Windows tor.exe. Re-run scripts/fetch-tor.sh (it replaces vendor/tor whole).');
    }
  } else {
    throw new Error(`Unknown platform "${platform}": use linux or win.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [platform, webBuild] = process.argv.slice(2);
    checkVendorTor(path.join(root, 'vendor'), platform);
    stageWeb(path.resolve(webBuild || path.join(root, '..', 'dist-desktop')), path.join(root, 'web'));
    console.log(`Staged the web build in web/ and checked the ${platform} tor in vendor/.`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

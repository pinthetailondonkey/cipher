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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Only the desktop build carries the onion group door (see src/lib/egress.js:
// a browser cannot reach an onion, the shell's own Tor can). Staging the web
// build here would make every group connection leave Tor without a word, so
// this refuses instead of packing it.
export function assertDesktopDoor(dir) {
  // The marker is written by scripts/build-desktop.mjs and by nothing else.
  // Looking for ".onion" in the bundle would not work: every build carries
  // that string in ordinary URL-parsing code, so a web build would pass.
  const marker = path.join(dir, 'cipher-desktop-build.json');
  let marked = false;
  try {
    marked = JSON.parse(fs.readFileSync(marker, 'utf8')).desktop === true;
  } catch {
    marked = false;
  }
  if (!marked) {
    throw new Error(`No group door in the build at ${dir}: this is a web build, and the desktop would quietly leave Tor for groups. Run "npm run build:desktop" in the cipher repo root and stage dist-desktop.`);
  }
}

export function stageWeb(webBuildDir, targetDir) {
  if (!fs.existsSync(path.join(webBuildDir, 'index.html'))) {
    throw new Error(`No build at ${webBuildDir}. Run "npm run build:desktop" in the cipher repo root first.`);
  }
  assertDesktopDoor(webBuildDir);
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

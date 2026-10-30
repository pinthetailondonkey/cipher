'use strict';
// Cipher Desktop shell. Design: docs/DESKTOP.md (feat/desktop-shell) - the
// decisions below are locked: Tor always on and bundled, the SOCKS route set
// before any page loads, WebRTC hard-disabled in private mode, data beside
// the app, plain 'Cipher' branding. There is no clearnet fallback, ever: if
// Tor cannot start, every connection fails instead of leaking.
//
// Env:
//   CIPHER_DIST   path to a built dist/        (default: sibling dist/ in dev, web/ in the bundle)
//   TOR_BIN       tor executable               (default: the bundled vendor/tor/tor/tor, else 'tor' on PATH)
//   TOR_SOCKS     socks port to speak to       (default 9050)
//   TAILS=1       use the SYSTEM tor, never spawn one (also detected from /etc/os-release)
//   CIPHER_CALLS=1 development escape hatch ONLY: allow WebRTC in private mode

const { app, BrowserWindow, dialog, ipcMain, safeStorage, session } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildTorArgs, parseOsRelease, socksPortFromTorrc, pickSocksPort, createRestartLimiter,
} = require('./tor.js');
const { createUiServer } = require('./uiServer.js');
const { dataDirBeside, resolveAppRoot, createDataDir } = require('./paths.js');
const { applyWindowPolicy, permissionAllowed, isUiUrl } = require('./windowPolicy.js');
const { createDeviceKeyBackend, registerDeviceKeyIpc } = require('./deviceKey.js');

const uiPort = 9151;
const appRoot = resolveAppRoot(process.execPath, {
  isPackaged: app.isPackaged,
  projectDir: path.resolve(__dirname, '..'),
});

// The route is set on the command line BEFORE the app is ready - Electron
// only honors switches read that early, and the promise this program makes
// is that no page ever sees any other route. The bypass is ONLY the
// loopback UI server; nothing else is exempt.
// The SOCKS port to speak to. TOR_SOCKS in the environment always wins. On
// Tails the system tor's own torrc is the truth (its default is 9050). Anywhere
// else the shell starts its OWN tor, so the port is one we know is free: 9050
// if nothing holds it, otherwise a random free one. We never point the proxy
// at whatever happens to listen on 9050, and the same number goes to the
// proxy switch below and to the tor we spawn, so the two cannot disagree.
function resolveSocksPort() {
  if (process.env.TOR_SOCKS) return Number(process.env.TOR_SOCKS);
  if (tailsMode()) {
    try {
      const fromTorrc = socksPortFromTorrc(fs.readFileSync('/etc/tor/torrc', 'utf8'));
      if (fromTorrc) return fromTorrc;
    } catch {
      // no torrc (or unreadable): the default stands
    }
    return 9050;
  }
  try {
    const { port, moved } = pickSocksPort({ preferred: 9050 });
    if (moved) console.log(`[desktop] port 9050 is in use; this Cipher's tor will use ${port}`);
    return port;
  } catch (e) {
    failLoudly('tor port', e.message);
    return 9050; // the app is quitting; no tor is started on it
  }
}

const socksPort = resolveSocksPort();
app.commandLine.appendSwitch('proxy-server', `socks5://127.0.0.1:${socksPort}`);
app.commandLine.appendSwitch('proxy-bypass-list', `127.0.0.1:${uiPort};localhost:${uiPort}`);
app.commandLine.appendSwitch('no-proxy-server-wpad');

// The web build the shell serves. Packaged, it lives inside the asar next
// to src (electron's fs reads asar paths transparently); in dev it is the
// sibling dist the repo's build emits; packaged, web/ staged by scripts/prepare-pack.mjs. CIPHER_DIST always wins.
const dist = path.resolve(
  process.env.CIPHER_DIST
  || (app.isPackaged ? path.join(__dirname, '..', 'web') : path.join(appRoot, '..', 'dist')),
);
// The bundled tor arrives via extraResources, outside the asar: a packed
// archive cannot be spawned. Dev, it is staged by scripts/fetch-tor.sh.
// The tor expert bundle ships `tor` on Linux and `tor.exe` on Windows
// (verified in the bundle layout: tor/tor.exe), so the path is whichever of
// the two is actually staged — one currency at a time in the same vendor/
// folder, one fetch script per pack. When neither is there the path still
// points at `tor`, and startTor below says its own plain words and refuses
// to leak: every connection fails instead.
function resolveTorBinary(dir) {
  for (const name of ['tor', 'tor.exe']) {
    if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return path.join(dir, 'tor');
}
const bundledTor = app.isPackaged
  ? resolveTorBinary(path.join(process.resourcesPath, 'vendor', 'tor', 'tor'))
  : resolveTorBinary(path.join(appRoot, 'vendor', 'tor', 'tor'));
const devCalls = process.env.CIPHER_CALLS === '1';

// Tails=1 env wins; otherwise the os-release check decides (src/tor.js).
function tailsMode() {
  return process.env.TAILS === '1' || (() => {
    try {
      return parseOsRelease(fs.readFileSync('/etc/os-release', 'utf8'));
    } catch {
      return false;
    }
  })();
}

let tor = null;
let torDataDir = null;
let torStopping = false; // true once the shell itself is stopping tor (quit, window closed)
let torStderr = ''; // the last lines tor wrote to stderr, for the message
const torRestarts = createRestartLimiter({ max: 3, windowMs: 10 * 60 * 1000 });

// A message that does not block the app and does not quit it. Every
// connection already fails while tor is down (the proxy points at a dead
// port), which is the safe state; the message says so in plain words.
function tellTorDown(text) {
  console.warn(`[desktop] ${text}`);
  dialog.showMessageBox({ type: 'warning', title: 'Cipher', message: text }).catch(() => {});
}

// On Tails we NEVER spawn tor: a second client would route inside a route
// (docs/DESKTOP.md). Anywhere else the shell owns the tor lifecycle:
// spawn on start with an ephemeral data dir, kill on quit, delete the dir.
// If tor dies on its own, restart it up to three times in ten minutes on the
// SAME port (the proxy switch cannot change after launch), then stop and say
// so. At no point does anything go direct: while tor is down, connections fail.
function startTor() {
  if (tailsMode()) {
    console.log(`[desktop] tails: using the system tor on 127.0.0.1:${socksPort}`);
    return null;
  }
  const candidates = [
    process.env.TOR_BIN,
    bundledTor,
    'tor',
  ].filter(Boolean);
  const bin = candidates.find((c) => c.includes(path.sep) ? fs.existsSync(c) : true);
  torDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-tor-'));
  torStderr = '';
  console.log(`[desktop] tor: starting ${bin} on 127.0.0.1:${socksPort} (temporary data folder, deleted on quit)`);
  const child = spawn(bin, buildTorArgs(torDataDir, socksPort), { stdio: ['ignore', 'ignore', 'pipe'] });
  tor = child;
  // Read stderr so a chatty tor can never fill the pipe and stall, and keep
  // the tail for the message.
  child.stderr.on('data', (d) => { torStderr = (torStderr + d).slice(-400); });
  let handled = false;
  const down = (why, canRestart) => {
    if (handled) return; // 'error' and 'exit' can both fire for one failure
    handled = true;
    if (tor === child) tor = null;
    if (torStopping) return;
    const tail = torStderr.trim() ? ` Tor said: ${torStderr.trim().split('\n').slice(-2).join(' / ')}` : '';
    if (canRestart && torRestarts.allow()) {
      tellTorDown(`Tor stopped (${why}). Cipher is starting it again. Until it is back, nothing connects - Cipher never sends anything outside Tor.${tail}`);
      removeTorDataDir();
      setTimeout(() => { if (!torStopping) startTor(); }, 2000);
    } else {
      tellTorDown(`Tor stopped (${why}) and Cipher could not bring it back. Nothing will connect until you close and reopen Cipher - it never sends anything outside Tor.${tail}`);
    }
  };
  // A tor that cannot be launched at all (missing file, no permission) will
  // not be fixed by trying again; a tor that ran and exited might be.
  child.on('error', (e) => down(`it could not start: ${e.message}`, false));
  child.on('exit', (code, signal) => down(`it exited with ${signal ? `signal ${signal}` : `code ${code}`}`, true));
  return child;
}

function removeTorDataDir() {
  if (torDataDir) {
    try {
      fs.rmSync(torDataDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[desktop] could not remove the temporary tor folder ${torDataDir}: ${e.message}`);
    }
    torDataDir = null;
  }
}

function stopTor() {
  torStopping = true;
  if (tor) {
    tor.kill();
    tor = null;
  }
  removeTorDataDir();
}

function failLoudly(title, message) {
  console.warn(`[desktop] ${title}: ${message}`);
  dialog.showErrorBox('Cipher', message);
  app.quit();
}

// Data beside the app, before anything else opens. If the folder cannot be
// written, say so in plain words and point at the portable build.
const dataDir = dataDirBeside(appRoot);
try {
  createDataDir(dataDir);
} catch (e) {
  failLoudly('data folder', e.message);
}

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  failLoudly('web build', `Cipher could not find the app build at ${dist}. `
    + 'Build the web app (npm run build in the cipher repo) or set CIPHER_DIST to its dist folder.');
}

app.whenReady().then(() => {
  app.on('quit', stopTor);

  // Data beside the app, not in a hidden per-user folder.
  app.setPath('userData', dataDir);

  // The device key lives in the same folder, sealed by the operating system
  // (src/deviceKey.js). Only the app's own page may ask for it, the same
  // line windowPolicy draws for everything else.
  registerDeviceKeyIpc({
    ipcMain,
    backend: createDeviceKeyBackend({ safeStorage, fs, dir: dataDir, randomBytes }),
    isAllowed: (event) => isUiUrl(event.senderFrame ? event.senderFrame.url : '', uiPort),
  });

  const engine = session.defaultSession;
  // Notification only (src/windowPolicy.js); mic/camera stay refused in private mode.
  engine.setPermissionRequestHandler((_wc, perm, cb) => cb(permissionAllowed(perm, { allowCalls: devCalls })));
  engine.setPermissionCheckHandler((_wc, perm) => permissionAllowed(perm, { allowCalls: devCalls }));
  engine.setUserAgent(`Cipher/${app.getVersion()}`);

  // Every webContents electron ever creates gets the same locks, before it
  // loads anything: window.open denied, navigation off the UI origin
  // cancelled, and WebRTC hard-off in private mode (src/windowPolicy.js).
  // The WebRTC policy is a webContents setting. Chromium's switch has no
  // 'never': disable_non_proxied_udp is the strictest, and because SOCKS
  // carries no UDP it leaves candidate gathering nowhere to go; TCP-only
  // TURN through the proxy still exists in theory, which is why this same
  // file's refusal of the mic permission stays the second lock.
  // CIPHER_CALLS=1 is the dev hatch.
  app.on('web-contents-created', (_event, contents) => {
    applyWindowPolicy(contents, { uiPort, allowCalls: devCalls });
  });

  const ui = createUiServer(dist, uiPort);
  ui.on('error', (e) => {
    failLoudly('Cipher', `${e.code === 'EADDRINUSE' ? 'Another Cipher is already running' : 'The UI server could not start'}. (${e.message})`);
  });
  ui.listen(() => {
    startTor();
    const win = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 960,
      minHeight: 600,
      title: 'Cipher',
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.js') },
    });
    win.removeMenu();
    win.loadURL(`http://127.0.0.1:${uiPort}/`);
    console.log(`[desktop] window up. Tor route: socks5://127.0.0.1:${socksPort}`
      + ` (default for every backend connection); WebRTC ${devCalls ? 'allowed (development escape hatch)' : 'engine-disabled'};`
      + ` mode: ${tailsMode() ? 'Tails, system tor' : 'bundled tor'}`);
  });
});

app.on('window-all-closed', () => {
  stopTor();
  app.quit();
});

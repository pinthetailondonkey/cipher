'use strict';
// Tor helpers that do not need electron, so they can be tested with plain node.
// Design: docs/DESKTOP.md (feat/desktop-shell) - Tor is always on. There is
// no clearnet fallback anywhere in this program, by design.

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// The arguments one tor client needs to serve SOCKS on the loopback port
// and keep nothing on disk but its own temporary state. Arg order matters
// only for readability; spawn passes them as-is.
function buildTorArgs(dataDir, socksPort) {
  return ['--SocksPort', `127.0.0.1:${socksPort}`, '--DataDirectory', dataDir];
}

// Tails is detected from the ID line of /etc/os-release. The file's text is
// the only input so the check stays testable. A quoted value counts
// (ID="tails"); a longer name like ID=tailsomething does not.
function parseOsRelease(text) {
  if (typeof text !== 'string') return false;
  return /^ID=["']?tails["']?\s*$/m.test(text);
}

// A candidate port for a tor we spawn ourselves (pickSocksPort checks it is
// free before it is used). Sockets the OS hands out start above 10000, so
// this stays out of their way.
function randomSocksPort() {
  return crypto.randomInt(10000, 65536);
}

// Is this loopback port free to bind right now? Answered synchronously on
// purpose: the proxy switch must be set on the command line before electron is
// ready, so the port has to be known before anything async can run. A child
// node (electron itself, run as node) tries to listen on it. Any doubt - the
// probe failed to run, timed out, or could not bind - counts as not free.
function portIsFreeSync(port) {
  const probe = "const s=require('node:net').createServer();"
    + "s.once('error',()=>process.exit(1));"
    + "s.listen(Number(process.argv[1]),'127.0.0.1',()=>s.close(()=>process.exit(0)));";
  const r = spawnSync(process.execPath, ['-e', probe, String(port)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
    timeout: 5000,
  });
  return r.status === 0;
}

// The SOCKS port for a tor we spawn ourselves: the preferred one (9050) when
// it is free, otherwise a free random one. Never "use whatever listens on
// 9050": a stranger's proxy there (or a system tor) is not the tor this shell
// started, and the shell's promise is that its own tor carries everything.
// Throws when nothing free is found; the caller fails closed.
function pickSocksPort({ preferred = 9050, isFree = portIsFreeSync, random = randomSocksPort, attempts = 20 } = {}) {
  if (isFree(preferred)) return { port: preferred, moved: false };
  for (let i = 0; i < attempts; i += 1) {
    const port = random();
    if (port !== preferred && isFree(port)) return { port, moved: true };
  }
  throw new Error(`Cipher could not find a free local port for its Tor (${preferred} is in use).`);
}

// How often a tor that keeps dying may be restarted: at most `max` times in
// `windowMs`. After that the shell stops trying and says so, and every
// connection keeps failing - there is no direct fallback at any point.
function createRestartLimiter({ max = 3, windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const stamps = [];
  return {
    allow() {
      const t = now();
      while (stamps.length && t - stamps[0] >= windowMs) stamps.shift();
      if (stamps.length >= max) return false;
      stamps.push(t);
      return true;
    },
  };
}

// On Tails the system tor's own torrc is the truth about its SOCKS port
// (today 9050, but the file is read, not trusted from memory). Returns the
// first loopback SocksPort, or null when the file says nothing usable —
// the caller then falls back to the default. Pure on the file's text so it
// stays testable.
function socksPortFromTorrc(text) {
  if (typeof text !== 'string') return null;
  for (const line of text.split('\n')) {
    // tor appends options on the same line (Tails: "IsolateDestAddr
    // IsolateDestPort"); anything after the port is allowed, a leading
    // comment is not the line speaking.
    const m = /^\s*SocksPort\s+127\.0\.0\.1:(\d+)(?:\s.*)?$/i.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

module.exports = {
  buildTorArgs, parseOsRelease, randomSocksPort, socksPortFromTorrc,
  portIsFreeSync, pickSocksPort, createRestartLimiter,
};

'use strict';
// Tor helpers that do not need electron, so they can be tested with plain node.
// Design: docs/DESKTOP.md (feat/desktop-shell) - Tor is always on. There is
// no clearnet fallback anywhere in this program, by design.

const crypto = require('node:crypto');

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

// A port for a tor we spawn ourselves. No reservation, no bookkeeping: if
// the port is taken, tor fails to start and the app fails loudly instead of
// changing the route (see src/main.js). Sockets the OS hands out start
// above 10000, so this stays out of their way.
function randomSocksPort() {
  return crypto.randomInt(10000, 65536);
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

module.exports = { buildTorArgs, parseOsRelease, randomSocksPort, socksPortFromTorrc };

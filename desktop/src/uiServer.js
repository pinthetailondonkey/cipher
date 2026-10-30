'use strict';
// The loopback UI server: serves the web app's built dist/ unmodified to the
// shell's window. Design: docs/DESKTOP.md (feat/desktop-shell) - the proxy
// bypass list covers ONLY this server, so it must stay loopback-only and
// never serve anything outside dist.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// The types Vite emits for dist files, from the reviewed spike.
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
};

// Headers on every answer, 200 or not. Intent follows vercel.json's CSP but is
// tighter where the desktop allows: calls are off in private mode (no stun or
// turn in connect-src), nothing may frame the page, no plugins, and the page
// can only submit to itself. connect-src keeps https/http/wss/ws because the
// relays, media hosts and .onion doors are chosen by the user and ride Tor
// through the proxy the shell pinned; the proxy, not the CSP, is the route.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http://*.onion",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' https: http: wss: ws:",
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// createUiServer(distAbsPath, port) returns a node:http server bound to the
// loopback host. It does not listen by itself; call.listen() on it.
// Guard semantics are the spike's, kept exactly: normalize + decode the
// pathname, join it under dist, and 404 anything that is not a real file
// inside dist, so a '..' path that resolves out of dist never answers.
function createUiServer(distAbsPath, port = 9151, host = '127.0.0.1') {
  const dist = path.resolve(distAbsPath);
  const server = http.createServer((req, res) => {
    let clean;
    try {
      clean = path.normalize(decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)).replace(/^\/+/, '');
    } catch {
      res.writeHead(400, SECURITY_HEADERS).end(); // a pathname that cannot be decoded (%x) is junk, not a file
      return;
    }
    const file = path.join(dist, clean === '' || clean === 'index.html' ? 'index.html' : clean);
    // The boundary matters: a bare startsWith(dist) also admits a sibling
    // folder that merely shares the prefix (dist-old, dist2), reachable with
    // '/../dist-old/x'. The file must be dist itself or sit under dist + sep.
    const inside = file === dist || file.startsWith(dist.endsWith(path.sep) ? dist : dist + path.sep);
    if (!inside || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return Object.assign(server, {
    listen(callback) {
      return http.Server.prototype.listen.call(server, port, host, callback);
    },
    dist,
    uiPort: port,
    host,
  });
}

module.exports = { createUiServer, MIME, CSP, SECURITY_HEADERS };

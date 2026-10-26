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
      res.writeHead(400).end(); // a pathname that cannot be decoded (%x) is junk, not a file
      return;
    }
    const file = path.join(dist, clean === '' || clean === 'index.html' ? 'index.html' : clean);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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

module.exports = { createUiServer, MIME };

// One command that brings up both boxes a vendor runs: the push gateway and
// the payment watcher. From a fresh clone this installs dependencies, writes
// .env from .env.example with a generated WATCH_TOKEN (so the URL pasted into
// Connections survives a restart), and starts both boxes in one process tree.
//
//   npm run boxes
//
// The push box watches a relay, which needs the global WebSocket that Node
// has only from version 22, so a wrong Node version is refused before
// anything is installed or started.
//
// Ctrl-C stops both boxes. Payment checks answer only while a wallet RPC
// from .env is reachable.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export const REQUIRED_NODE_MAJOR = 22;

export function makeWatchToken() {
  return randomBytes(24).toString('base64url');
}

// The requirement is named in the message, not just an exit code, so a wrong
// Node version fails telling the vendor which Node to install and why.
export function assertNodeVersion(version = process.version) {
  const match = /^v(\d+)\./.exec(version);
  const major = match ? Number(match[1]) : 0;
  if (major >= REQUIRED_NODE_MAJOR) return major;
  throw new Error(
    `Node ${REQUIRED_NODE_MAJOR} or newer is required. The push box watches a relay, `
    + `and the global WebSocket arrived in Node 22. This is Node ${version}.`,
  );
}

// The first address a phone on the same network can reach. Empty when there
// is none, so the caller falls back to loopback and says so.
export function pickLanIp(interfaces = os.networkInterfaces()) {
  for (const rows of Object.values(interfaces)) {
    for (const row of rows || []) {
      if (row.family === 'IPv4' && !row.internal) return row.address;
    }
  }
  return '';
}

// Copy .env.example to .env when there is no .env, and make sure WATCH_TOKEN
// holds a value. An existing token is never replaced: the phone already has
// it pasted. Returns the token both boxes will run with.
export function ensureEnvFile(root, token = makeWatchToken()) {
  const envPath = path.join(root, '.env');
  let text;
  let existed = true;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    try {
      text = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    } catch {
      throw new Error('No .env and no .env.example. Write a .env with WATCH_TOKEN= in it.');
    }
    existed = false;
  }
  const present = /^WATCH_TOKEN=(.+)$/m.exec(text);
  if (present && present[1].trim()) return { token: present[1].trim(), created: false, changed: false };
  const line = `WATCH_TOKEN=${token}`;
  const next = /^WATCH_TOKEN=\s*$/m.test(text)
    ? text.replace(/^WATCH_TOKEN=\s*$/m, line)
    : text.replace(/\n*$/, `\n${line}\n`);
  fs.writeFileSync(envPath, next);
  return { token, created: !existed, changed: true };
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

function watch(children) {
  let stopped = false;
  const stopAll = () => {
    if (stopped) return;
    stopped = true;
    for (const child of children) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopAll();
      process.exit(0);
    });
  }
  for (const child of children) {
    child.on('exit', (code, signal) => {
      if (stopped) return;
      stopped = true;
      stopAll();
      console.error(`[boxes] A box stopped (${signal || code}). Stopping the other one.`);
      process.exit(code ?? 1);
    });
  }
}

async function main() {
  try {
    assertNodeVersion();
  } catch (error) {
    console.error(`[boxes] ${error.message}`);
    process.exit(1);
  }
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

  if (!fs.existsSync(path.join(root, 'node_modules', 'web-push', 'package.json'))) {
    console.error('[boxes] Installing dependencies (first run on a fresh clone).');
    try {
      await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], root);
    } catch (error) {
      console.error(`[boxes] ${error.message}. Install them with npm install and run npm run boxes again.`);
      process.exit(1);
    }
  }

  let env;
  try {
    env = ensureEnvFile(root);
  } catch (error) {
    console.error(`[boxes] ${error.message}`);
    process.exit(1);
  }
  if (env.created) console.error('[boxes] Wrote .env from .env.example.');
  if (env.changed) console.error('[boxes] Generated a WATCH_TOKEN into .env. It stays the token until you change it.');

  const lanIp = pickLanIp();
  const host = lanIp || '127.0.0.1';
  const watcherUrl = `http://${host}:8788/payment?token=${env.token}`;
  if (lanIp) {
    console.log(`[boxes] Watcher:   ${watcherUrl}`);
    console.log(`[boxes] Push box:  http://${host}:8787`);
  } else {
    console.log(`[boxes] Watcher:   ${watcherUrl}`);
    console.log('[boxes] No LAN address was found, so that URL only works on this machine.');
    console.log('[boxes] Push box:  http://127.0.0.1:8787');
  }
  console.log('[boxes] Paste the watcher URL into Connections → Payment watcher, and the push box address into Connections → Push gateway.');
  console.log('[boxes] Payment checks answer only while a wallet RPC from .env is reachable.');
  console.log('[boxes] Ctrl-C stops both boxes.');

  const node = process.execPath;
  const children = [
    spawn(node, [path.join(root, 'scripts', 'notify-gateway.mjs')], { cwd: root, stdio: 'inherit' }),
    spawn(node, [path.join(root, 'scripts', 'payment-watcher.mjs')], { cwd: root, stdio: 'inherit' }),
  ];
  watch(children);
}

// Same entry test as payment-watcher.mjs: importing this file from a test
// must not start the boxes.
function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`[boxes] ${error.message}`);
    process.exit(1);
  });
}

#!/usr/bin/env node
// Isolated NIP-01 transport exercise against two independent local relay
// processes. This is an R1 evaluation harness only: it does not change the
// production group transport or configure user relays.
//
// Requires a locally built groups_relay binary and its source settings.yml:
// CIPHER_TEST_RELAY_BIN=/path/to/groups_relay
// CIPHER_TEST_RELAY_SETTINGS=/path/to/groups_relay/config/settings.yml

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';

const relayBin = process.env.CIPHER_TEST_RELAY_BIN;
const settingsTemplate = process.env.CIPHER_TEST_RELAY_SETTINGS;
if (!relayBin || !settingsTemplate) {
  throw new Error('Set CIPHER_TEST_RELAY_BIN and CIPHER_TEST_RELAY_SETTINGS to a locally built isolated relay.');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

const root = await mkdtemp(path.join(os.tmpdir(), 'cipher-ordinary-relays-'));
const template = await readFile(settingsTemplate, 'utf8');
const ports = [await freePort(), await freePort()];
const relayUrls = ports.map((port) => `ws://127.0.0.1:${port}`);
const configDirs = [];
const children = new Map();
let browser;
let browserPage;
const phase = (name) => console.log(`[ordinary-relay-chaos] ${name}`);

async function makeConfig(index) {
  const dir = path.join(root, `relay-${index}`);
  const db = path.join(dir, 'db');
  await mkdir(db, { recursive: true });
  const port = ports[index];
  const settings = template
    .replace(/relay_secret_key:\s*"[^"]+"/, `relay_secret_key: "${randomBytes(32).toString('hex')}"`)
    .replace(/local_addr:\s*"[^"]+"/, `local_addr: "127.0.0.1:${port}"`)
    .replace(/relay_url:\s*"[^"]+"/, `relay_url: "ws://127.0.0.1:${port}"`)
    .replace(/db_path:\s*"[^"]+"/, `db_path: "${db}"`);
  await writeFile(path.join(dir, 'settings.yml'), settings, { mode: 0o600 });
  configDirs[index] = dir;
}

function startRelay(index) {
  const child = spawn(relayBin, [
    '--config-dir', configDirs[index],
    '--relay-url', relayUrls[index],
    '--local-addr', `127.0.0.1:${ports[index]}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-12000); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-12000); });
  child.once('error', (error) => { output = `${output}\nspawn error: ${error.message}`; });
  children.set(index, { child, get output() { return output; } });
  return child;
}

async function stopRelay(index) {
  const running = children.get(index);
  if (!running || running.child.exitCode !== null) return;
  const waitForExit = async (timeoutMs) => {
    if (running.child.exitCode !== null || running.child.signalCode !== null) return true;
    return Promise.race([
      new Promise((resolve) => running.child.once('exit', () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  };
  running.child.kill('SIGTERM');
  if (await waitForExit(5000)) return;
  running.child.kill('SIGKILL');
  await waitForExit(3000);
}

async function waitForRelay(index, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < until) {
    if (children.get(index)?.child.exitCode !== null) {
      throw new Error(`Relay ${index} exited during startup: ${children.get(index).output}`);
    }
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection(ports[index], '127.0.0.1');
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('TCP connect timeout')); }, 500);
        socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
        socket.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
      return;
    } catch (error) {
      lastError = error.message;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Relay ${index} did not become ready (${lastError}): ${children.get(index)?.output || ''}`);
}

async function connect(index, name) {
  await browserPage.evaluate(({ url, socketName }) => new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const entry = { socket, frames: [] };
    window.relaySockets.set(socketName, entry);
    const timer = setTimeout(() => reject(new Error(`socket ${socketName} open timed out`)), 5000);
    socket.onopen = () => { clearTimeout(timer); resolve(true); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error(`socket ${socketName} failed`)); };
    socket.onmessage = ({ data }) => {
      try { entry.frames.push(JSON.parse(data)); } catch { /* invalid relay frame is ignored */ }
    };
  }), { url: relayUrls[index], socketName: name });
}

async function takeFrame(name, expected, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const frame = await browserPage.evaluate(({ socketName, match }) => {
      const entry = window.relaySockets.get(socketName);
      const matches = (frame) => {
        if (match.type === 'OK') return frame[0] === 'OK' && frame[1] === match.id;
        if (match.type === 'subscription') {
          return frame[1] === match.id && ['EVENT', 'EOSE', 'CLOSED'].includes(frame[0]);
        }
        return false;
      };
      const at = entry.frames.findIndex(matches);
      return at < 0 ? null : entry.frames.splice(at, 1)[0];
    }, { socketName: name, match: expected });
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a relay frame on ${name}`);
}

async function publish(name, event) {
  await browserPage.evaluate(({ socketName, eventValue }) => {
    window.relaySockets.get(socketName).socket.send(JSON.stringify(['EVENT', eventValue]));
  }, { socketName: name, eventValue: event });
  const ok = await takeFrame(name, { type: 'OK', id: event.id });
  assert.equal(ok[2], true, `NIP-01 EVENT accepted by ${name}: ${ok[3] || ''}`);
}

async function query(name, id, eventId) {
  await browserPage.evaluate(({ socketName, subId, wantedId }) => {
    window.relaySockets.get(socketName).socket.send(JSON.stringify(['REQ', subId, { ids: [wantedId] }]));
  }, { socketName: name, subId: id, wantedId: eventId });
  const events = [];
  while (true) {
    const frame = await takeFrame(name, { type: 'subscription', id });
    if (frame[0] === 'EOSE') return events;
    assert.notEqual(frame[0], 'CLOSED', `NIP-01 REQ accepted by ${name}: ${frame[2] || ''}`);
    events.push(frame[2]);
  }
}

function makeEvent(secretKey, label) {
  return finalizeEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['t', 'cipher-r1-ordinary-relay-test']],
    content: label,
  }, secretKey);
}

try {
  await Promise.all([makeConfig(0), makeConfig(1)]);
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  browserPage = await context.newPage();

  phase('start two independent relay processes');
  startRelay(0);
  startRelay(1);
  await waitForRelay(0);
  await browserPage.goto(`http://127.0.0.1:${ports[0]}/health`);
  await browserPage.evaluate(() => { window.relaySockets = new Map(); });
  await waitForRelay(1);
  phase('connect and publish a shared event');
  await connect(0, 'a-online');
  await connect(1, 'b-online');

  const sender = generateSecretKey();
  const common = makeEvent(sender, 'available on both independent relays');
  await Promise.all([publish('a-online', common), publish('b-online', common)]);
  assert.equal((await query('a-online', 'common-a', common.id)).length, 1, 'relay A stores and returns the shared event');
  assert.equal((await query('b-online', 'common-b', common.id)).length, 1, 'relay B independently stores and returns the shared event');

  phase('verify relay-specific withholding');
  const withheldByB = makeEvent(sender, 'relay B withholds this event');
  await publish('a-online', withheldByB);
  assert.equal((await query('a-online', 'only-a', withheldByB.id)).length, 1, 'relay A has the event');
  assert.equal((await query('b-online', 'withheld-b', withheldByB.id)).length, 0, 'an empty answer from relay B does not erase relay A data');

  phase('stop relay A and verify B remains available');
  await stopRelay(0);
  const duringOutage = makeEvent(sender, 'queued while relay A is down');
  await publish('b-online', duringOutage);
  assert.equal((await query('b-online', 'outage-b', duringOutage.id)).length, 1, 'relay B remains available during A outage');
  let unavailable = false;
  try { await waitForRelay(0, 800); } catch { unavailable = true; }
  assert.ok(unavailable, 'relay A outage is observable and bounded');

  phase('restart A and explicitly replay the missing event');
  startRelay(0);
  await waitForRelay(0);
  await connect(0, 'a-recovered');
  assert.equal((await query('a-recovered', 'pre-sync-a', duringOutage.id)).length, 0,
    'independent relays do not magically synchronize an event received during outage');
  await publish('a-recovered', duringOutage);
  assert.equal((await query('a-recovered', 'post-sync-a', duringOutage.id)).length, 1,
    'explicit client replay synchronizes the recovered relay');
  assert.equal((await query('b-online', 'post-sync-b', duringOutage.id)).length, 1,
    'the event remains available on relay B after recovery');

  console.log(JSON.stringify({
    result: 'PASS',
    transport: 'NIP-01 kind:1 over captured browser WebSocket frames',
    independentRelays: 2,
    cases: ['dual publish/read', 'relay-specific withheld event', 'single-relay outage', 'other-relay availability', 'explicit recovery replay'],
    eventIds: { common: common.id, withheldByB: withheldByB.id, recovered: duringOutage.id },
    automaticRelaySelection: 'not exercised; production relay selection remains fixed separately',
  }, null, 2));
} finally {
  await browserPage?.close().catch(() => {});
  for (const index of [...children.keys()]) await stopRelay(index).catch(() => {});
  await browser?.close().catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

// Focused test for scripts/fault-proxy.mjs (I3).
//
// Proves on the wire, against the disposable local relay:
//   1. pass-through: an EVENT published through the proxy gets relayed and
//      its OK acknowledgement returns;
//   2. latency: with clientToRelayLatencyMs set, the relay sees the EVENT
//      after at least the injected delay;
//   3. drop-once: the next relay->client frame matching a predicate never
//      reaches the client, and the record shows the drop;
//   4. per-connection record: endpoints and both directions are captured.
//
// Node 20 (this workspace's runtime) has no global WebSocket client, so the
// spec drives a minimal raw-socket WebSocket client built on the same frame
// encoding the local relay itself parses. That keeps the test honest about
// wire bytes without adding a dependency.

import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createLocalNip01Relay } from './local-nip01-relay.mjs';
import { createFaultProxy } from './fault-proxy.mjs';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

// --- minimal WebSocket client over a raw socket ---

class RawWebSocket {
  constructor(url) {
    const parsed = new URL(url);
    this.socket = net.connect(Number(parsed.port), parsed.hostname);
    this.buffer = Buffer.alloc(0);
    this.handlers = { open: [], message: [], close: [], error: [] };
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.resolveOpen = resolve;
    });
    this.socket.once('connect', () => {
      const key = randomBytes(16).toString('base64');
      this.socket.write(
        `GET ${parsed.pathname || '/'} HTTP/1.1\r\n`
        + `Host: ${parsed.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    this.socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (!this.handshaken) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = this.buffer.subarray(0, end).toString('utf8');
        if (!/HTTP\/1\.1 101/.test(head)) {
          this.emit('error', new Error(`upgrade refused: ${head.split('\r\n')[0]}`));
          return;
        }
        this.buffer = this.buffer.subarray(end + 4);
        this.handshaken = true;
        this.resolveOpen();
      }
      this.drain();
    });
    this.socket.on('close', () => this.emit('close'));
    this.socket.on('error', (error) => this.emit('error', error));
  }

  // Takes one complete unmasked frame from the buffer, if any.
  takeFrame() {
    if (this.buffer.length < 2) return null;
    const second = this.buffer[1];
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return null;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return null;
      length = Number(this.buffer.readBigUInt64BE(2));
      offset = 10;
    }
    if (this.buffer.length < offset + length) return null;
    const payload = this.buffer.subarray(offset, offset + length).toString('utf8');
    this.buffer = this.buffer.subarray(offset + length);
    return payload;
  }

  drain() {
    while (true) {
      if (!this.handshaken) return;
      const text = this.takeFrame();
      if (text == null) return;
      this.emit('message', text);
    }
  }

  on(event, handler) { this.handlers[event].push(handler); }
  emit(event, ...args) { for (const handler of this.handlers[event]) handler(...args); }

  send(text) {
    // Client frames are masked per RFC 6455.
    const payload = Buffer.from(text);
    let extra;
    if (payload.length < 126) extra = Buffer.alloc(0);
    else if (payload.length <= 0xffff) {
      extra = Buffer.alloc(2);
      extra.writeUInt16BE(payload.length, 0);
    } else {
      extra = Buffer.alloc(8);
      extra.writeBigUInt64BE(BigInt(payload.length), 0);
    }
    const maskKey = randomBytes(4);
    const body = Buffer.alloc(payload.length);
    payload.forEach((byte, index) => { body[index] = byte ^ maskKey[index % 4]; });
    this.socket.write(Buffer.concat([
      Buffer.from([0x81, 0x80 | Math.min(payload.length, 126)]),
      extra, maskKey, body,
    ]));
  }

  close() { this.socket.end(); }
}

async function connectWebSocket(url) {
  const ws = new RawWebSocket(url);
  await ws.opened;
  return ws;
}

function nextFrame(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.on('message', () => {});
      reject(new Error('timed out waiting for frame'));
    }, timeoutMs);
    const handler = (text) => {
      if (predicate(text)) {
        clearTimeout(timer);
        socket.handlers.message = socket.handlers.message.filter((h) => h !== handler);
        resolve(text);
      }
    };
    socket.on('message', handler);
  });
}

const sk = generateSecretKey();
const event = finalizeEvent(
  { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'fault-proxy-probe' },
  sk,
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- case 1 + 4: pass-through and per-connection records ---
{
  const relay = await createLocalNip01Relay();
  const proxy = await createFaultProxy({ upstreamPort: Number(new URL(relay.url).port) });
  const ws = await connectWebSocket(proxy.url);
  ws.send(JSON.stringify(['REQ', 'sub1', { kinds: [1] }]));
  await nextFrame(ws, (text) => text.includes('EOSE'));
  ws.send(JSON.stringify(['EVENT', event]));
  await nextFrame(ws, (text) => text.startsWith('["OK"'));
  const conn = proxy.connections[0];
  assert.ok(conn, 'proxy kept a connection record');
  assert.ok(conn.frames.some((entry) => entry.kind === 'frame' && entry.direction === 'client-to-relay' && entry.text.startsWith('["EVENT"')));
  assert.ok(conn.frames.some((entry) => entry.kind === 'frame' && entry.direction === 'relay-to-client' && entry.text.startsWith('["OK"')));
  assert.equal(conn.clientAddress, '127.0.0.1');
  ws.close();
  await wait(50);
  await proxy.close();
  await relay.close();
}

// --- case 2: latency injection ---
{
  const relay = await createLocalNip01Relay();
  const LATENCY_MS = 250;
  const proxy = await createFaultProxy({
    upstreamPort: Number(new URL(relay.url).port),
    clientToRelayLatencyMs: LATENCY_MS,
  });
  const ws = await connectWebSocket(proxy.url);
  ws.send(JSON.stringify(['REQ', 'sub-lat', { kinds: [1] }]));
  await nextFrame(ws, (text) => text.includes('EOSE'), 8000);
  const sentAt = Date.now();
  ws.send(JSON.stringify(['EVENT', event]));
  await nextFrame(ws, (text) => text.startsWith('["OK"'), 4000);
  const observed = relay.frames.find(({ direction, frame }) => direction === 'client' && frame[0] === 'EVENT');
  assert.ok(observed, 'the relay saw the event through the proxy');
  const elapsed = observed.atMs - sentAt;
  assert.ok(elapsed >= LATENCY_MS * 0.8, `latency injected before relay saw EVENT (${elapsed}ms)`);
  ws.close();
  await wait(50);
  await proxy.close();
  await relay.close();
}

// --- case 3: drop-once faults with recorded evidence ---
{
  const relay = await createLocalNip01Relay();
  const proxy = await createFaultProxy({
    upstreamPort: Number(new URL(relay.url).port),
    dropOnce: { direction: 'relay-to-client', match: ['EOSE'] },
  });
  const ws = await connectWebSocket(proxy.url);
  ws.send(JSON.stringify(['REQ', 'sub-drop', { kinds: [1] }]));
  // The publish path still flows through the proxy.
  ws.send(JSON.stringify(['EVENT', event]));
  await nextFrame(ws, (text) => text.startsWith('["OK"'), 3000);
  // A second REQ's EOSE passes through, proving the drop was once-only.
  ws.send(JSON.stringify(['REQ', 'sub-drop-2', { kinds: [1] }]));
  await nextFrame(ws, (text) => text.includes('sub-drop-2') && text.includes('EOSE'), 3000);
  const dropped = proxy.connections.flatMap((conn) => conn.frames)
    .filter((entry) => entry.kind === 'dropped-frame' && entry.direction === 'relay-to-client');
  assert.equal(dropped.length, 1, 'exactly one relay->client frame was dropped');
  assert.ok(dropped[0].text.includes('sub-drop'), 'the dropped frame was the first subscription EOSE');
  ws.close();
  await wait(50);
  await proxy.close();
  await relay.close();
}

console.log('fault-proxy focused test passed: pass-through+records, latency injection, drop-once with evidence.');
process.exit(0);

// Minimal raw-socket WebSocket client for Node test harnesses (TEST-PATH-ONLY).
//
// Extracted verbatim in spirit from scripts/fault-proxy.test.mjs so
// scripts/protocol-dm-e2e.mjs can drive real WebSocket wire bytes without a
// browser and without editing coordinator-owned files. Node 20 has no global
// WebSocket client, so this drives the same frame encoding the local relay
// parses. Not production code; not an anonymity or transport claim.

import net from 'node:net';
import { randomBytes } from 'node:crypto';

export class RawWebSocket {
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

export async function connectRawWebSocket(url) {
  const ws = new RawWebSocket(url);
  await ws.opened;
  return ws;
}

// Resolves with the next relay->client frame matching predicate(text).
export function nextFrame(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs);
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

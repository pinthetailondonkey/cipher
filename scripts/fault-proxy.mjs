#!/usr/bin/env node
// I3 — Fault proxy (protocol build plan v2, §5 I3).
//
// A WebSocket fault proxy that sits in front of the disposable local relay
// (scripts/local-nip01-relay.mjs) or any loopback WebSocket endpoint. It is
// used by Phase 3 expiry and AUTH tests where the fault must live on the
// wire between the app and the relay rather than inside either.
//
// What it does:
//   - per-connection latency injection in each direction,
//   - drop-the-next-frame faults selected by a JSON predicate,
//   - frame mutation hooks (rewrite the next matching frame's payload text),
//   - a per-connection record of every frame: direction, bytes, parsed text,
//     timestamps, and both endpoints' addresses/ports.
//
// The proxy is deliberately dumb about Nostr semantics: it pipes opaque
// frames between one client socket and one upstream socket per connection
// and records both directions. Fault selection is explicit at construction
// time; every injected fault is recorded so evidence shows what actually
// happened on the wire rather than what a test hoped for.
//
// Loopback only: test infrastructure; refuses non-loopback binds.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeServerFrame(text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function maskClientFrame(text) {
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
  const maskKey = Buffer.from(Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)));
  const body = Buffer.alloc(payload.length);
  payload.forEach((byte, index) => { body[index] = byte ^ maskKey[index % 4]; });
  return Buffer.concat([
    Buffer.from([0x81, 0x80 | Math.min(payload.length, 126)]),
    extra,
    maskKey,
    body,
  ]);
}

function takeMaskedFrames(buffer) {
  // Client->proxy frames are masked.
  const out = [];
  while (true) {
    if (buffer.length < 2) break;
    const second = buffer[1];
    const opcode = buffer[0] & 0x0f;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) break;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) break;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    if (!(second & 0x80)) throw new Error('Upstream client frame was not masked.');
    if (buffer.length < offset + 4 + length) break;
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    out.push({ opcode, payload, rest: buffer.subarray(offset + length) });
    buffer = out[out.length - 1].rest;
  }
  return out;
}

function takePlainFrames(buffer) {
  // Proxy->client / upstream->proxy frames are unmasked.
  const out = [];
  while (true) {
    if (buffer.length < 2) break;
    const second = buffer[1];
    const opcode = buffer[0] & 0x0f;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) break;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) break;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    if (second & 0x80) throw new Error('Downstream server frame must not be masked.');
    if (buffer.length < offset + length) break;
    out.push({ opcode, payload: buffer.subarray(offset, offset + length), rest: buffer.subarray(offset + length) });
    buffer = out[out.length - 1].rest;
  }
  return out;
}

const matchesPredicate = (predicate, text, meta) => {
  if (!predicate) return true;
  if (typeof predicate === 'function') return !!predicate(text, meta);
  if (Array.isArray(predicate)) {
    // Match a leading NIP-01 message type, e.g. ['EVENT'] or ['OK'].
    try {
      const value = JSON.parse(text);
      return Array.isArray(value) && predicate.includes(value[0]);
    } catch {
      return false;
    }
  }
  return text.includes(String(predicate));
};

export async function createFaultProxy({
  upstreamHost = '127.0.0.1',
  upstreamPort,
  host = '127.0.0.1',
  port = 0,
  // Latency injected before forwarding, per direction, milliseconds.
  clientToRelayLatencyMs = 0,
  relayToClientLatencyMs = 0,
  // Drop the next matching frame in a given direction once.
  dropOnce = null, // { direction: 'client-to-relay'|'relay-to-client', match }
  // Rewrite the next matching frame in a given direction once, by function.
  mutateOnce = null, // { direction, match, transform(text) -> text|null }
} = {}) {
  if (!LOOPBACK_HOSTS.has(host) || !LOOPBACK_HOSTS.has(upstreamHost)) {
    throw new Error('The fault proxy is loopback-only test infrastructure.');
  }
  if (!Number.isSafeInteger(upstreamPort) || upstreamPort <= 0) {
    throw new Error('The fault proxy needs an upstream port.');
  }
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('fault-proxy');
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const connections = [];
  const openSockets = new Set();
  let nextConnectionId = 1;

  server.on('upgrade', (request, clientSocket) => {
    const key = request.headers['sec-websocket-key'];
    if (request.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      clientSocket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    const connectionId = nextConnectionId++;
    const record = [];
    const connection = {
      connectionId,
      openedAtMs: Date.now(),
      clientAddress: request.socket.remoteAddress,
      clientPort: request.socket.remotePort,
      upstreamHost,
      upstreamPort,
      frames: record,
    };
    connections.push(connection);
    openSockets.add(clientSocket);

    // Connect upstream and complete its HTTP WebSocket upgrade before the
    // client's 101. The relay (like any conformant server) only parses frames
    // on a socket that upgraded, so a raw connect is not enough.
    const upstreamKey = randomBytes(16).toString('base64');
    const upstream = connect(upstreamPort, upstreamHost);
    openSockets.add(upstream);
    upstream.upgradeSent = false;
    upstream.once('error', () => {
      record.push({ atMs: Date.now(), kind: 'upstream-connect-error', message: `could not reach ${upstreamHost}:${upstreamPort}` });
      clientSocket.destroy();
    });
    upstream.once('connect', () => {
      connection.upstreamLocalAddress = upstream.localAddress;
      connection.upstreamLocalPort = upstream.localPort;
      upstream.write(
        `GET / HTTP/1.1\r\n`
        + `Host: ${upstreamHost}:${upstreamPort}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${upstreamKey}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });

    upstream.on('data', function onData(chunk) {
      if (!upstream.upgradeSent) {
        const end = chunk.indexOf('\r\n\r\n');
        if (end === -1) return; // headers not complete yet
        const head = (Buffer.from(chunk).subarray(0, end)).toString('utf8');
        if (!/HTTP\/1\.1 101/.test(head)) {
          record.push({ atMs: Date.now(), kind: 'upstream-upgrade-refused', head });
          clientSocket.destroy();
          upstream.destroy();
          return;
        }
        upstream.upgradeSent = true;
        upstream.off('data', onData);
        attachFramePumps();
      }
    });

    let dropSpec = dropOnce ? { ...dropOnce } : null;
    let mutateSpec = mutateOnce ? { ...mutateOnce } : null;

    const note = (entry) => record.push({ atMs: Date.now(), ...entry });

    const forwardText = ({ direction, text, write }) => {
      // Drop-once: exactly the first matching frame in this direction.
      if (dropSpec && dropSpec.direction === direction && matchesPredicate(dropSpec.match, text, connection)) {
        dropSpec = null;
        note({ kind: 'dropped-frame', direction, text });
        return;
      }
      let toSend = text;
      if (mutateSpec && mutateSpec.direction === direction && matchesPredicate(mutateSpec.match, text, connection)) {
        const transformed = mutateSpec.transform(toSend);
        mutateSpec = null;
        if (transformed == null) {
          note({ kind: 'dropped-by-mutation', direction, original: text });
          return;
        }
        note({ kind: 'mutated-frame', direction, original: text, replacedWith: transformed });
        toSend = transformed;
      }
      const latency = direction === 'client-to-relay' ? clientToRelayLatencyMs : relayToClientLatencyMs;
      const send = () => {
        if (write.destroyed) {
          note({ kind: 'write-after-close', direction, text: toSend });
          return;
        }
        write.write(direction === 'client-to-relay' ? maskClientFrame(toSend) : encodeServerFrame(toSend));
      };
      if (latency > 0) setTimeout(send, latency);
      else send();
      note({ kind: 'frame', direction, text, latencyInjectedMs: latency });
    };

    let clientBuffer = Buffer.alloc(0);
    let upstreamBuffer = Buffer.alloc(0);

    // After the upstream upgrade completes, pump frames both ways and write
    // the client's own 101 only once the whole chain can carry frames.
    function attachFramePumps() {
      clientSocket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      clientSocket.resume();

      clientSocket.on('data', (chunk) => {
        clientBuffer = Buffer.concat([clientBuffer, chunk]);
        try {
          for (const frame of takeMaskedFrames(clientBuffer)) {
            clientBuffer = frame.rest;
            if (frame.opcode === 8) {
              note({ kind: 'close', direction: 'client-to-relay' });
              upstream.end();
              continue;
            }
            if (frame.opcode !== 1) continue;
            forwardText({ direction: 'client-to-relay', text: frame.payload.toString('utf8'), write: upstream });
          }
        } catch (error) {
          note({ kind: 'protocol-error', direction: 'client-to-relay', message: error.message });
          clientSocket.destroy();
          upstream.destroy();
        }
      });

      upstream.on('data', (chunk) => {
        upstreamBuffer = Buffer.concat([upstreamBuffer, chunk]);
        try {
          for (const frame of takePlainFrames(upstreamBuffer)) {
            upstreamBuffer = frame.rest;
            if (frame.opcode === 8) {
              note({ kind: 'close', direction: 'relay-to-client' });
              clientSocket.end();
              continue;
            }
            if (frame.opcode !== 1) continue;
            forwardText({ direction: 'relay-to-client', text: frame.payload.toString('utf8'), write: clientSocket });
          }
        } catch (error) {
          note({ kind: 'protocol-error', direction: 'relay-to-client', message: error.message });
          clientSocket.destroy();
          upstream.destroy();
        }
      });
    }

    // Client frames queue up while the upstream handshake completes; pause
    // the client socket so nothing is lost before the pumps attach.
    clientSocket.pause();
    clientSocket.on('data', () => {}); // keep flow control aware; real parsing in pumps

    const cleanup = () => {
      openSockets.delete(clientSocket);
      openSockets.delete(upstream);
      if (!connection.closedAtMs) connection.closedAtMs = Date.now();
    };
    clientSocket.on('close', cleanup);
    clientSocket.on('error', cleanup);
    upstream.on('close', cleanup);
    upstream.on('error', cleanup);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();

  return {
    url: `ws://${host}:${address.port}`,
    port: address.port,
    connections,
    async close() {
      for (const socket of openSockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { verifyEvent } from 'nostr-tools/pure';

function encodeFrame(text) {
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

function takeClientFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const wide = buffer.readBigUInt64BE(2);
    if (wide > BigInt(1024 * 1024)) throw new Error('Local relay frame is too large.');
    length = Number(wide);
    offset = 10;
  }
  const masked = (second & 0x80) !== 0;
  if (!masked) throw new Error('Browser WebSocket client frame was not masked.');
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { opcode, payload, rest: buffer.subarray(offset + length) };
}

function matches(filter, event) {
  if (filter.ids && !filter.ids.some((prefix) => event.id.startsWith(prefix))) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.some((prefix) => event.pubkey.startsWith(prefix))) return false;
  if (Number.isSafeInteger(filter.since) && event.created_at < filter.since) return false;
  if (Number.isSafeInteger(filter.until) && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(values)
      && !event.tags.some((tag) => tag[0] === key.slice(1) && values.includes(tag[1]))) return false;
  }
  return true;
}

// Disposable local NIP-01 relay used only by browser integration tests. It
// verifies signed events, implements EVENT/REQ/CLOSE/COUNT responses, and
// captures only traffic from these synthetic clients on loopback.
export async function createLocalNip01Relay({
  host = '127.0.0.1',
  port = 0,
  requireAuth = false,
  deliveryDelayMs = 0,
  holdDeliveries = false,
  authChallengeForConnection = null,
} = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('The disposable NIP-01 relay must bind to a loopback host.');
  }
  if (!Number.isSafeInteger(deliveryDelayMs) || deliveryDelayMs < 0 || deliveryDelayMs > 30_000) {
    throw new Error('Event delivery delay must be between 0 and 30000 milliseconds.');
  }
  if (authChallengeForConnection !== null && typeof authChallengeForConnection !== 'function') {
    throw new Error('AUTH challenge factory must be a function.');
  }
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('local-nip01-relay');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const clients = new Set();
  const events = new Map();
  const frames = [];
  const connections = [];
  const dropNextAcknowledgement = new Set();
  const connectionBySocket = new Map();
  const pendingDeliveries = [];
  let deliveryPaused = holdDeliveries;
  let nextConnectionId = 1;
  let relayUrl = null;

  const record = (direction, socket, frame, extra = {}) => {
    const connection = connectionBySocket.get(socket);
    frames.push({ direction, connectionId: connection?.connectionId ?? null,
      remoteAddress: connection?.remoteAddress ?? null, remotePort: connection?.remotePort ?? null,
      atMs: Date.now(), frame, ...extra });
  };
  const writeFrame = (socket, frame, extra = {}) => {
    if (socket.destroyed) return;
    record('relay', socket, frame, extra);
    socket.write(encodeFrame(JSON.stringify(frame)));
  };
  const transmitDelivery = ({ socket, frame, queuedAtMs }) => {
    const send = () => writeFrame(socket, frame, { queuedAtMs, deliveryDelayMs });
    if (deliveryDelayMs > 0) setTimeout(send, deliveryDelayMs);
    else send();
  };
  const deliver = (socket, frame) => {
    const item = { socket, frame, queuedAtMs: Date.now() };
    if (deliveryPaused) pendingDeliveries.push(item);
    else transmitDelivery(item);
  };

  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (request.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.buffered = Buffer.alloc(0);
    socket.subscriptions = new Map();
    socket.authorized = !requireAuth;
    const connectionId = nextConnectionId++;
    const connection = { connectionId, openedAtMs: Date.now(), remoteAddress: request.socket.remoteAddress,
      remotePort: request.socket.remotePort, localAddress: request.socket.localAddress,
      localPort: request.socket.localPort };
    connectionBySocket.set(socket, connection);
    clients.add(socket);
    connections.push(connection);
    const challenge = authChallengeForConnection
      ? authChallengeForConnection(connectionId)
      : randomBytes(32).toString('hex');
    if (typeof challenge !== 'string' || challenge.length < 16 || challenge.length > 128) {
      socket.destroy();
      return;
    }
    socket.authChallenge = challenge;
    socket.on('close', () => { clients.delete(socket); connectionBySocket.delete(socket); });
    socket.on('error', () => { clients.delete(socket); connectionBySocket.delete(socket); });
    if (requireAuth) writeFrame(socket, ['AUTH', challenge]);
    socket.on('data', (chunk) => {
      try {
        socket.buffered = Buffer.concat([socket.buffered, chunk]);
        while (true) {
          const parsed = takeClientFrame(socket.buffered);
          if (!parsed) break;
          socket.buffered = parsed.rest;
          if (parsed.opcode === 8) { socket.end(); break; }
          if (parsed.opcode !== 1) continue;
          const value = JSON.parse(parsed.payload.toString('utf8'));
          record('client', socket, value);
          if (value[0] === 'AUTH') {
            const event = value[1];
            const valid = !!event && event.kind === 22242 && verifyEvent(event)
              && event.tags.some((tag) => tag[0] === 'relay' && tag[1] === relayUrl)
              && event.tags.some((tag) => tag[0] === 'challenge' && tag[1] === socket.authChallenge);
            if (valid) socket.authorized = true;
            writeFrame(socket, ['OK', event?.id || '', valid, valid ? 'authenticated' : 'invalid: AUTH challenge or signature']);
          } else if (value[0] === 'EVENT') {
            const event = value[1];
            if (requireAuth && !socket.authorized) {
              writeFrame(socket, ['OK', event?.id || '', false, 'auth-required: authenticate before publishing']);
              continue;
            }
            const accepted = !!event?.id && verifyEvent(event);
            if (accepted) events.set(event.id, event);
            const answer = ['OK', event?.id || '', accepted, accepted ? 'saved' : 'invalid: event verification failed'];
            if (accepted && dropNextAcknowledgement.delete(event.id)) {
              record('test-fault', socket, ['TEST_DROP_ACK', event.id]);
            } else {
              writeFrame(socket, answer);
            }
            if (accepted) {
              for (const subscriber of clients) {
                for (const [subscriptionId, filters] of subscriber.subscriptions || []) {
                  if (filters.some((filter) => matches(filter, event))) {
                    const delivery = ['EVENT', subscriptionId, event];
                    deliver(subscriber, delivery);
                  }
                }
              }
            }
          } else if (value[0] === 'REQ' && typeof value[1] === 'string') {
            const [, subscriptionId, ...filters] = value;
            if (requireAuth && !socket.authorized) {
              writeFrame(socket, ['CLOSED', subscriptionId, 'auth-required: authenticate before subscribing']);
              continue;
            }
            socket.subscriptions.set(subscriptionId, filters);
            const results = Array.from(events.values()).filter((event) => filters.some((filter) => matches(filter, event)));
            for (const event of results) {
              const answer = ['EVENT', subscriptionId, event];
              deliver(socket, answer);
            }
            const eose = ['EOSE', subscriptionId];
            writeFrame(socket, eose);
          } else if (value[0] === 'CLOSE') {
            socket.subscriptions.delete(value[1]);
          } else if (value[0] === 'COUNT') {
            if (requireAuth && !socket.authorized) {
              writeFrame(socket, ['CLOSED', value[1], 'auth-required: authenticate before counting']);
              continue;
            }
            const answer = ['COUNT', value[1], { count: events.size }];
            writeFrame(socket, answer);
          }
        }
      } catch (error) {
        record('fixture-error', socket, null, { message: error?.message || String(error) });
        socket.destroy();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  relayUrl = `ws://${host === '::1' ? '[::1]' : host}:${address.port}`;
  return {
    url: relayUrl,
    frames,
    connections,
    events,
    dropAcknowledgementOnce(eventId) { dropNextAcknowledgement.add(eventId); },
    pauseDeliveries() { deliveryPaused = true; },
    resumeDeliveries({ reverse = false } = {}) {
      deliveryPaused = false;
      const batch = pendingDeliveries.splice(0);
      if (reverse) batch.reverse();
      for (const delivery of batch) transmitDelivery(delivery);
      return batch.length;
    },
    async close() {
      for (const socket of clients) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

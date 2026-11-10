// Entry forwarder (plan item 10 / I10). Accepts a client WebSocket on
// loopback and dials onward to the mailbox relay, shuttling frames while
// logging per-hop timing and sizes. Prototype only; web-forwarder evidence is
// pending two-operator tests.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { WS_MAGIC, encodeFrame, encodeClientFrame, takeClientFrame, takeServerFrame } from './wsFraming.mjs';

export function startEntryForwarder({ listenPort = 0, relayHost = '127.0.0.1', relayPort }) {
  const logs = [];
  let server = null;
  return new Promise((resolve, reject) => {
    server = createServer();
    server.on('error', reject);
    server.on('upgrade', (request, socket, head) => {
      if (typeof head === 'function') head();
      if (request.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
      if (head && head.length) {
        // Bytes pipelined with the upgrade request are frames; deliver them
        // through the same data path by re-emitting after handlers attach.
        setImmediate(() => socket.emit('data', head));
      }
      const clientKey = request.headers['sec-websocket-key'] ?? 'dGhlIHNhbXBsZSBub25jZQ==';
      const serverAccept = createHash('sha1')
        .update(`${clientKey}${WS_MAGIC}`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${serverAccept}\r\n\r\n`);
      logs.push({ hop: 'entry.client', direction: 'upgrade-in', atMs: Date.now(),
        remoteAddress: request.socket.remoteAddress });
      // Dial onward to the mailbox relay from THIS process, so the relay's
      // peer address is the forwarder's listening socket identity, not the
      // original client's.
      const upstream = connect(relayPort, relayHost, () => {});
      upstream.write(`GET / HTTP/1.1\r\nHost: ${relayHost}:${relayPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${clientKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      let upBuf = Buffer.alloc(0);
      let downBuf = Buffer.alloc(0);
      let downHandshaked = false;
      let handshaked = false;

      upstream.on('data', (chunk) => {
        if (!handshaked) {
          upBuf = Buffer.concat([upBuf, chunk]);
          const idx = upBuf.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const headEnd = idx + 4;
          const head = upBuf.subarray(0, headEnd).toString();
          if (!head.includes('101')) { logs.push({ hop: 'entry.relay', direction: 'handshake-fail', head }); socket.destroy(); return; }
          handshaked = true;
          logs.push({ hop: 'entry.relay', direction: 'upgraded', atMs: Date.now(),
            localAddressSeenByRelay: upstream.localAddress, localPortSeenByRelay: upstream.localPort,
            remoteAddress: `${relayHost}:${relayPort}` });
          // Keep any pipelined frames that arrived in this same chunk.
          upBuf = Buffer.from(upBuf.subarray(headEnd));
        } else {
          upBuf = Buffer.concat([upBuf, chunk]);
        }
        for (;;) {
          const frame = takeServerFrame(upBuf);
          if (!frame) break;
          upBuf = frame.rest;
          logs.push({ hop: 'entry.relay', direction: 'relay->client', atMs: Date.now(), sizeBytes: frame.payload.length });
          socket.write(encodeFrame(frame.payload.toString()));
        }
      });

      socket.on('data', (chunk) => {
        downBuf = Buffer.concat([downBuf, chunk]);
        if (!downHandshaked) {
          // The client's upgrade request is consumed by Node's 'upgrade' event;
          // any buffered bytes here are frames unless a raw handshake header
          // was not seen. A frame-only chunk contains no '\r\n\r\n' and no
          // valid frame either (header looks binary), so treat a chunk that
          // starts with a parseable masked frame as post-handshake traffic.
          const maybeFrame = (() => {
            try { return takeClientFrame(downBuf); } catch { return undefined; }
          })();
          if (!maybeFrame && downBuf.indexOf('\r\n\r\n') !== -1) {
            const idx = downBuf.indexOf('\r\n\r\n');
            downBuf = downBuf.subarray(idx + 4);
          } else {
            downHandshaked = true; // frame traffic only from here on
          }
        }
        for (;;) {
          let frame;
          try { frame = takeClientFrame(downBuf); } catch { downBuf = Buffer.alloc(0); break; }
          if (!frame) break;
          downBuf = frame.rest;
          logs.push({ hop: 'entry.client', direction: 'client->relay', atMs: Date.now(), sizeBytes: frame.payload.length });
          upstream.write(encodeClientFrame(frame.payload.toString()));
        }
      });
      const teardown = () => {
        if (socket.destroyed && upstream.destroyed) return;
        try { upstream.destroy(); } catch {}
        try { socket.destroy(); } catch {}
      };
      socket.on('close', teardown);
      upstream.on('close', teardown);
      upstream.on('error', () => teardown());
    });
    server.listen(listenPort, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, logs,
        stop: () => new Promise((ok) => {
          // Prototype teardown: force-close any lingering upgrade sockets so
          // server.close resolves even when a client vanished mid-hop. The
          // close callback also self-resolves after a grace period because
          // half-open relayed sockets may not surface to closeAllConnections.
          if (typeof server.closeAllConnections === 'function') {
            try { server.closeAllConnections(); } catch {}
          }
          let done = false;
          const finish = () => { if (!done) { done = true; ok(); } };
          setTimeout(finish, 150);
          server.close(finish);
        }) });
    });
  });
}

export { encodeFrame };

// Mailbox-side capture (plan item 10 / I10). A minimal WebSocket relay that
// records, for every connection, the peer address it sees. In the per-hop test
// the real origin is simulated behind the entry forwarder, so this log must
// show only the forwarder's source address, never a distinct client identity.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { WS_MAGIC, encodeFrame, takeClientFrame } from './wsFraming.mjs';

export function startMailboxCaptureRelay({ port = 0 }) {
  const logs = [];
  const frames = [];
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    if (request.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}${WS_MAGIC}`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    logs.push({ hop: 'mailbox', direction: 'connection-opened', atMs: Date.now(),
      remoteAddressSeenByMailboxRelay: request.socket.remoteAddress,
      remotePortSeenByMailboxRelay: request.socket.remotePort });
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        let frame;
        try { frame = takeClientFrame(buf); } catch { buf = Buffer.alloc(0); break; }
        if (!frame) break;
        buf = frame.rest;
        frames.push({ atMs: Date.now(), sizeBytes: frame.payload.length,
          remoteAddressSeenByMailboxRelay: request.socket.remoteAddress });
        // Echo an acknowledgement frame back.
        socket.write(encodeFrame(JSON.stringify(['OK', frame.payload.length])));
      }
    });
    socket.on('close', () => logs.push({ hop: 'mailbox', direction: 'connection-closed', atMs: Date.now() }));
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      server, port: server.address().port, logs, frames,
      stop: () => new Promise((ok) => {
        if (typeof server.closeAllConnections === 'function') {
          try { server.closeAllConnections(); } catch {}
        }
        let done = false;
        const finish = () => { if (!done) { done = true; ok(); } };
        setTimeout(finish, 150);
        server.close(finish);
      }),
    }));
  });
}

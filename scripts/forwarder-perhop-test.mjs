// Per-hop forwarder test (plan item 10 / I10). Runs the entry forwarder and
// mailbox capture relay on loopback ports, connects a simulated origin client
// to the ENTRY forwarder (never directly to the relay), and asserts that the
// mailbox sees only the forwarder's listening socket identity.
//
// Evidence label: 'partial, web-forwarder evidence pending two-operator tests'
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { startEntryForwarder } from './forwarder/entryForwarder.mjs';
import { startMailboxCaptureRelay } from './forwarder/mailboxCapture.mjs';
import { WS_MAGIC, encodeClientFrame, takeServerFrame } from './forwarder/wsFraming.mjs';

function dialWebSocket(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = connect(port, host);
    const key = createHash('sha1').update(String(Date.now()) + String(port)).digest('base64');
    let buf = Buffer.alloc(0);
    const fail = (e) => { try { socket.destroy(); } catch {} reject(e); };
    socket.on('error', fail);
    socket.on('connect', () => {
      socket.write(`GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!socket.__upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.subarray(0, idx + 4).toString();
        const expectedAccept = createHash('sha1').update(`${key}${WS_MAGIC}`).digest('base64');
        if (!head.includes(`Sec-WebSocket-Accept: ${expectedAccept}`)) return fail(new Error('Bad WS handshake.'));
        socket.__upgraded = true;
        // Keep any frame bytes that arrived with the handshake and everything
        // that follows; readFrames consumes this buffer.
        socket.__frameBuf = Buffer.from(buf.subarray(idx + 4));
        buf = Buffer.alloc(0);
        socket.setNoDelay(true);
        resolve({ socket,
          localAddressSeenByForwarder: socket.localAddress,
          localPortSeenByForwarder: socket.localPort,
          readFrames() {
            const frames = [];
            let rest = socket.__frameBuf ?? Buffer.alloc(0);
            for (;;) {
              const f = takeServerFrame(rest);
              if (!f) break;
              rest = f.rest;
              frames.push(JSON.parse(f.payload.toString()));
            }
            socket.__frameBuf = rest;
            return frames;
          },
        });
      } else {
        socket.__frameBuf = Buffer.concat([socket.__frameBuf ?? Buffer.alloc(0), chunk]);
      }
    });
  });
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function main() {
  const label = 'partial, web-forwarder evidence pending two-operator tests';
  const mailbox = await startMailboxCaptureRelay({ port: 0 });
  const forwarder = await startEntryForwarder({ listenPort: 0, relayHost: '127.0.0.1', relayPort: mailbox.port });

  // Simulated real origin dials ONLY the entry forwarder.
  const client = await dialWebSocket(forwarder.port);
  await sleep(200); // let both handshakes settle before the first frame
  client.socket.write(encodeClientFrame(JSON.stringify(['EVENT', { synthetic: true, payload: 'x'.repeat(400) }])));
  await sleep(300);

  const hops = [...mailbox.logs, ...forwarder.logs].sort((a, b) => a.atMs - b.atMs);
  const perHopLines = hops.map((h) => JSON.stringify(h));

  // Assertions
  const failures = [];
  const opened = mailbox.logs.filter((l) => l.direction === 'connection-opened');
  if (opened.length !== 1) failures.push(`expected exactly one mailbox connection, saw ${opened.length}`);
  for (const o of opened) {
    if (o.remoteAddressSeenByMailboxRelay !== '127.0.0.1') {
      failures.push(`mailbox saw non-loopback address ${o.remoteAddressSeenByMailboxRelay}`);
    }
  }
  await sleep(100);
  const acks = client.readFrames();
  if (!acks.some((f) => f[0] === 'OK')) failures.push('no ACK frame returned through both hops');

  // The distinct identity of the simulated origin is its ephemeral port pair
  // toward the FORWARDER; the mailbox log must contain no port other than the
  // forwarder's own upstream source port(s).
  const mailboxPorts = new Set(opened.map((o) => o.remotePortSeenByMailboxRelay));
  if (client.localPortSeenByForwarder !== undefined
    && mailboxPorts.has(client.localPortSeenByForwarder)) {
    failures.push('mailbox saw the simulated origin\'s original source port; identity leaked past the forwarder');
  }

  const result = {
    schema: 'forwarder-perhop-test-v1',
    evidenceLabel: label,
    topology: 'simulated-origin -> entry-forwarder (loopback) -> mailbox-capture-relay (loopback)',
    assertions: {
      singleMailboxConnection: opened.length === 1,
      mailboxSeesLoopbackOnly: opened.every((o) => o.remoteAddressSeenByMailboxRelay === '127.0.0.1'),
      originSourcePortHiddenFromMailbox: !failures.some((f) => f.includes('identity leaked')),
      ackReturnedThroughBothHops: acks.length > 0,
    },
    pass: failures.length === 0,
    failures,
  };

  process.stdout.write(JSON.stringify({
    ...result,
    perHopLogLines: perHopLines,
    note: `${label}. Loopback-only prototype: this shows a relay-side address observation, not operator-level anonymity or multi-network correlation resistance.`,
  }, null, 2) + '\n');

  try { client.socket.end(); } catch {}
  await sleep(100);
  try { client.socket.destroy(); } catch {}
  await forwarder.stop();
  await mailbox.stop();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('per-hop test failed:', err.message);
  console.error('(if loopback binding is unavailable in this sandbox, this fails with EACCES/EADDRNOTAVAIL rather than being forced)');
  process.exit(2);
});

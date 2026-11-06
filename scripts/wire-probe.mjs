// The isolation probe of the wire capture (docs/LAUNCH-LOG.md Phase 11).
//
//   node scripts/wire-probe.mjs <port>
//
// A raw WebSocket client that handshakes with scripts/wire-capture.mjs's
// --wait servers, answers nothing, sends one well-formed EVENT, and asserts
// the relay answers it with OK. Exit 0 = relay dispatch path works; any
// change to the capture relay's frame decoding re-runs this before a full
// capture so a broken OK path costs seconds, not a whole app drive.
import net from 'node:net';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] || 8098);

function maskPayload(str) {
  const payload = Buffer.from(str);
  const maskKey = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ maskKey[i % 4];
  return Buffer.concat([header, maskKey, masked]);
}

const key = crypto.randomBytes(16).toString('base64');
const sock = net.connect(PORT, '127.0.0.1', () => {
  sock.write(`GET /group HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
});

let buf = Buffer.alloc(0);
let done = false;
sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  // Fast path: treat any decoded text-ish frame by scanning for readable ASCII
  const s = buf.toString('latin1');
  const hits = [...s.matchAll(/\[(?:\\|"|.)?(?:EOSE|OK|AUTH)/g)].map((m) => m[0]);
  if (!done && (hits.length || s.includes('101'))) {
    console.log('bytes-in:', chunk.length, '| markers:', JSON.stringify(hits));
  }
  if (hits.some((h) => h.includes('OK')) || s.includes('"OK"')) { done = true; finish(true); }
});
sock.on('error', (e) => { console.log('socket error:', e.message); process.exit(1); });
setTimeout(() => finish(false), 6000);

function finish(ok) {
  console.log(ok ? 'GREEN: relay answered with OK' : 'RED: no relay answer within 6s');
  sock.destroy();
  process.exit(ok ? 0 : 1);
}

setTimeout(() => {
  console.log('sending EVENT probe');
  const ev = JSON.stringify({ kind: 99999, created_at: Math.floor(Date.now()/1000), tags: [], content: '', pubkey: 'aa'.repeat(32), id: 'bb'.repeat(32), sig: 'cc'.repeat(128) });
  sock.write(maskPayload(JSON.stringify(['EVENT', JSON.parse(ev)])));
}, 800);

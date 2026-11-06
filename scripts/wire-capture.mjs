// THE WIRE CAPTURE.
//
//   node scripts/wire-capture.mjs dist <outPrefix>
//   node scripts/wire-analyze.mjs <outPrefix>.jsonl <account-pk> [pins.csv]
//   node scripts/wire-probe.mjs <port>          (--wait mode probe client)
//
// Run `node scripts/wire-capture.mjs dist out --wait` to bring up only the
// servers, then probe them with wire-probe.mjs in isolation.
//
// What this proves, read against docs/LAUNCH-LOG.md Phase 11 "The wire itself
// was read": while no root or tcpdump exists on a dev box and TLS would
// blind one anyway, CDP records every WebSocket frame headless Chromium puts
// on the wire while the REAL app (production build, real PIN gate, seeded
// vault) creates a group and messages two local stand-in relays pointed at
// through cipher_network's paste channel. Every frame lands verbatim in a
// JSONL file plus the account pubkey and every alias pin seen; the analyzer
// then greps those bytes for the account key.
//
// The relay overrides come through cipher_network's documented paste channel;
// no tracked file is touched and no env var reaches the build.

import { chromium } from 'playwright';
// --wait: servers come up and stay quiet; used with scripts/wsprobe.mjs to
// exercise the relay path in isolation, without the app run.
const WAIT_ONLY = process.argv.includes('--wait');
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { getPublicKey, finalizeEvent } from 'nostr-tools';

const DIST = process.argv[2] || 'dist';
const PREFIX = process.argv[3] || 'capture';
if (!fs.existsSync(`${DIST}/index.html`)) throw new Error(`no build in ${DIST}`);

// Same seed recipe as tests/ui/fixtures.js (TEST_SK all-170 bytes).
const SK = Array.from({ length: 32 }, () => 170);
const PK = getPublicKey(Uint8Array.from(SK));
console.log(`account pk: ${PK}`);

const pinsSeen = new Set();
let seqN = 0;
// Incremental: a crashed run must not lose its capture. Every frame lands on
// disk as it happens; the end-of-run step only finalizes pins.
const CAPTURE_PREFIX = PREFIX;
const captureFile = `${CAPTURE_PREFIX}.jsonl`;
fs.writeFileSync(captureFile, '');
fs.writeFileSync(`${CAPTURE_PREFIX}-pk.txt`, PK.toLowerCase());
const note = (dir, url, data) => {
  seqN += 1;
  fs.appendFileSync(captureFile, JSON.stringify({ seq: seqN, ts: Date.now(), dir, url, data }) + '\n');
};

// ── Static server ───────────────────────────────────────────────────────────
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const PORT_HTTP = 8099;
const PORT_GROUP = 8098;
const PORT_GENERAL = 8097;
const httpServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
  const file = `${DIST}${url}`;
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': types[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } else if (url.startsWith('/assets/')) {
    res.writeHead(404); res.end('not found');
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fs.readFileSync(`${DIST}/index.html`));
  }
});
await new Promise((r) => httpServer.listen(PORT_HTTP, 'localhost', r));
console.log(`http :${PORT_HTTP}  group-capture :${PORT_GROUP}  general-capture :${PORT_GENERAL}`);

// ── Capture relay ───────────────────────────────────────────────────────────
function handShake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { console.log('[relay] upgrade without a key'); socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  console.log('[relay] handshake ->', req.url);
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
}
function wsFrame(socket, text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length > 65535) { const ext = Buffer.alloc(8); ext.writeBigUInt64BE(BigInt(payload.length)); header = Buffer.concat([Buffer.from([0x81, 127]), ext]); }
  else if (payload.length > 125) { const ext = Buffer.alloc(2); ext.writeUInt16BE(payload.length); header = Buffer.concat([Buffer.from([0x81, 126]), ext]); }
  else header = Buffer.from([0x81, payload.length]);
  const out = Buffer.concat([header, payload]);
  console.log(`[relay->] ${socket.roleTag || '?'} write ${out.length}b: ${text.slice(0, 60)}`);
  const okWrite = socket.write(out);
  if (!okWrite) console.log('[relay->] WRITE BUFFERED (backpressure)');
}
// The relay side signs challenges with its own throwaway secret. A relay is
// not an account; this key never enters the analysis.
const relaySk = crypto.randomBytes(32);

function decodeClientFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  let off = 2;
  const len0 = buf[1] & 0x7f;
  let len = len0;
  if (len0 === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(off); off += 2; }
  else if (len0 === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(off)); off += 8; }
  const masked = (buf[1] & 0x80) !== 0;
  if (masked && buf.length < off + 4 + len) return null;
  if (!masked && buf.length < off + len) return null;
  if (!masked) return { opcode, fin, buf: buf.slice(off, off + len), consumed: off + len };
  const mask = buf.slice(off, off + 4); off += 4;
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = buf[off + i] ^ mask[i % 4];
  return { opcode, fin, buf: out, consumed: off + len };
}

// A real group relay opens with an AUTH challenge (NIP-42): the raw-socket
// session stays unauthed until one arrives and is answered. The capture
// relay issues exactly one on connect and then goes quiet; a second
// challenge after an answer would trap both sides in a signing loop.
function sendChallenge(socket) {
  if (socket.authChallenged || socket.authOk) return;
  socket.authChallenged = true;
  const port = socket.roleTag === 'general' ? PORT_GENERAL : PORT_GROUP;
  const challenge = finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000), tags: [['challenge', crypto.randomBytes(16).toString('hex')], ['relay', `ws://127.0.0.1:${port}/${socket.roleTag}`]], content: '' }, relaySk);
  wsFrame(socket, JSON.stringify(['AUTH', challenge]));
}
async function handleClientFrames(socket, text, role) {
  console.log(`[relay:deliver] enter role=${role} len=${text.length}`);
  note('recv-app-to-relay', role, text);
  harvestPins(text);
  let cmds;
  try { cmds = JSON.parse(text); } catch { console.log('[relay] unparsable frame:', text.slice(0, 120)); return; }
  console.log(`[relay:parsed] isArray=${Array.isArray(cmds)} type=${typeof cmds} head=${text.slice(0, 40)}`);
  if (!Array.isArray(cmds)) return;
  // A nostr frame IS one command: ['EVENT', ev] / ['REQ', id, ...filters].
  // The earlier loop treated this array as a LIST of commands and skipped
  // every element ('EVENT' string, event object), so no OK or EOSE ever
  // left the capture relay. Dispatch on the array itself.
  const cmd = cmds;
  const replyFor = () => {
    if (cmd[0] === 'REQ') return JSON.stringify(['EOSE', cmd[1]]);
    if (cmd[0] === 'EVENT') return JSON.stringify(['OK', cmd[1]?.id || '', true, '']);
    return null;
  };
  console.log(`[relay] <- ${cmd[0]}${cmd[1]?.id ? ' ' + String(cmd[1].id).slice(0, 8) : typeof cmd[1] === 'string' ? ' ' + cmd[1].slice(0, 8) : ''}`);
  if (cmd[0] === 'REQ') { const reply = replyFor(); note('relay-to-client', role, reply); wsFrame(socket, reply); }
  else if (cmd[0] === 'EVENT') { const reply = replyFor(); note('relay-to-client', role, reply); console.log(`[relay] -> OK ${String(cmd[1]?.id).slice(0, 8)}`); wsFrame(socket, reply); }
  else if (cmd[0] === 'CLOSE') {}
  else if (/^auth$/i.test(String(cmd[0]))) {
    // The AUTH answer arrived. The app marks the session authed itself once
    // its proof resolves; re-challenging here would put both sides in a
    // signing loop. A successful answer buys silence.
    socket.authOk = true;
  }
}

function harvestPins(data) {
  try {
    const arr = JSON.parse(data);
    const flat = Array.isArray(arr) ? arr.flat(Infinity) : [arr];
    for (const item of flat) {
      if (item && typeof item === 'object' && typeof item.pubkey === 'string') {
        const hex = item.pubkey.toLowerCase();
        if (hex !== PK.toLowerCase()) pinsSeen.add(hex);
      }
      for (const t of Array.isArray(item?.tags) ? item.tags : []) {
        if ((t[0] === 'author' || t[0] === 'p') && /^[0-9a-f]{66}$/i.test(t[1])) pinsSeen.add(t[1].toLowerCase());
      }
    }
  } catch { /* non-JSON frames happen */ }
}

const wsServer = http.createServer((req, res) => { res.writeHead(200); res.end(); });
wsServer.on('upgrade', (req, socket) => {
  handShake(req, socket);
  // Each socket carries its capture role so a frame records which box it
  // crossed: group and general are separate trust domains, and the claim
  // the analyzer witnesses is scoped to the group box alone.
  socket.roleTag = 'group';
  sendChallenge(socket);
  attachFrameDrain(socket);
});
const generalServer = http.createServer((req, res) => { res.writeHead(200); res.end(); });
generalServer.on('upgrade', (req, socket) => {
  handShake(req, socket);
  socket.roleTag = 'general';
  sendChallenge(socket);
  attachFrameDrain(socket);
});
function attachFrameDrain(socket) {
  let pending = Buffer.alloc(0);
  // Chromium fragments larger text messages into several WS frames; a
  // fragmented EVENT must be reassembled before it can be parsed and OK'd,
  // or the sender waits forever for the relay's answer.
  let msgParts = [];
  const deliver = async (parts) => {
    const text = Buffer.concat(parts).toString();
    await handleClientFrames(socket, text, socket.roleTag);
  };
  socket.on('data', (chunk) => {
    console.log(`[relay] bytes ${chunk.length}`);
    pending = Buffer.concat([pending, chunk]);
    void (async () => {
      while (true) {
        const d = decodeClientFrame(pending);
        if (!d) { if (pending.length > 0) console.log(`[relay] partial ${pending.length}b buffered`); break; }
        pending = pending.slice(d.consumed);
        if (d.opcode === 0x1 || d.opcode === 0x2) {
          msgParts = [d.buf];
          if (d.fin) { const parts = [...msgParts]; msgParts = []; await deliver(parts); }
        } else if (d.opcode === 0x0) {
          msgParts.push(d.buf);
          if (d.fin) { const parts = [...msgParts]; msgParts = []; await deliver(parts); }
        } else if (d.opcode === 0x8) socket.end();
        else if (d.opcode === 0x9) socket.write(Buffer.from([0x8a, 0])); // ping -> pong
      }
    })().catch((e) => console.log('[relay] handler error:', e?.message || String(e)));
  });
}
await new Promise((r) => wsServer.listen(PORT_GROUP, '127.0.0.1', r));
await new Promise((r) => generalServer.listen(PORT_GENERAL, '127.0.0.1', r));
process.on('uncaughtException', (e) => console.log('[fatal-uncaught]', e?.stack || String(e)));
process.on('unhandledRejection', (e) => console.log('[fatal-rejection]', e?.stack || String(e)));
if (WAIT_ONLY) {
  console.log('--wait: capture servers up and staying quiet; probe away.');
  setInterval(() => console.log('[heartbeat] alive'), 5000);
  await new Promise(() => {});
}

// ── The app run ─────────────────────────────────────────────────────────────
const RELAY_GROUP = `ws://127.0.0.1:${PORT_GROUP}/group`;
const RELAY_GENERAL = `ws://127.0.0.1:${PORT_GENERAL}/general`;
const net = JSON.stringify({
  overrides: {
    'group-relay': RELAY_GROUP,
    'group-relay-2': RELAY_GROUP,
    'dm-relay': RELAY_GENERAL,
    'profile-nos': RELAY_GENERAL,
    'profile-damus': RELAY_GENERAL,
    'profile-purple': RELAY_GENERAL,
    'search-vertex': RELAY_GENERAL,
    'search-noswhere': RELAY_GENERAL,
  },
  lists: { profile: [], dm: [] },
});

const PIN = '13572468';
const enc = new TextEncoder();
const salt = crypto.getRandomValues(new Uint8Array(16));
const material = await crypto.subtle.importKey('raw', enc.encode(PIN), { name: 'PBKDF2' }, false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(SK)));
const vault = { iv: Array.from(iv), data: Array.from(new Uint8Array(ct)), salt: Array.from(salt), iter: 600000 };

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();

  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', (p) => console.log('ws open:', p.url));
  cdp.on('Network.webSocketHandshakeResponseReceived', (p) => console.log('ws handshake status:', p.response?.status));
  cdp.on('Network.webSocketFrameError', (p) => console.log('ws frame ERROR:', p.errorMessage));
  cdp.on('Network.webSocketClosed', (p) => console.log('ws closed'));
  cdp.on('Network.webSocketFrameSent', (p) => {
    const payload = p.response?.payloadData;
    if (typeof payload === 'string' && payload.length) note('sent', 'browser-wire', payload);
  });
  // What the capture endpoint answered, seen from the other end: this is
  // how a missing OK gets distinguished from a mangled one.
  cdp.on('Network.webSocketFrameReceived', (p) => {
    const payload = p.response?.payloadData;
    if (typeof payload === 'string' && payload.length) note('recv-from-relay', 'browser-wire', payload);
  });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page-error]', m.text().slice(0, 300)); });
  page.on('pageerror', (e) => console.log('[page-exception]', String(e).slice(0, 300)));

  await page.addInitScript(({ pk, v, n }) => {
    localStorage.setItem('cipher_vaults', JSON.stringify({ [pk]: { vault: v, handle: 'capture', displayName: 'Capture', createdAt: 1700000000000, confirmed: true } }));
    localStorage.setItem('cipher_active_pubkey', pk);
    localStorage.setItem('cipher_network', n);
  }, { pk: PK, v: vault, n: net });

  // A headless browser ships no authenticator; without one the vault opens
  // but the account cannot be locked to this device and the gate refuses.
  // The same virtual authenticator offline-probe.mjs uses, via CDP.
  const wcdp = await context.newCDPSession(page);
  await wcdp.send('WebAuthn.enable');
  await wcdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } });

  console.log('boot: opening app');
  await page.goto(`http://localhost:${PORT_HTTP}/`);
  await page.getByRole('heading', { name: 'Unlock Cipher' }).waitFor({ timeout: 30000 });

  console.log('unlock via PIN pad');
  const pad = page.getByRole('group', { name: 'Number pad' });
  for (const digit of PIN) await pad.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  try {
    await page.getByRole('heading', { name: 'Unlock Cipher' }).waitFor({ state: 'hidden', timeout: 30000 });
  } catch {
    const alertText = await page.getByRole('alert').textContent().catch(() => '');
    const dots = await page.getByRole('group', { name: 'PIN digits entered' }).count();
    await page.screenshot({ path: `${PREFIX}-unlock-stuck.png` });
    throw new Error(`unlock stuck; alert="${alertText}"; dots-group=${dots}`);
  }
  console.log('unlocked');

  console.log('open chat list menu -> New group');
  await page.getByLabel('Chat list menu').click();
  await page.getByText('New group', { exact: true }).click();

  console.log('fill create-group modal');
  await page.getByPlaceholder('e.g. Weekend plans').fill('Capture probe group');
  await page.getByRole('button', { name: 'Create group' }).click();
  await page.getByPlaceholder(/Weekend plans|e\.g\./).first().waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
  console.log('create submitted');

  console.log('send one message into the group');
  await page.getByLabel('Message', { exact: true }).waitFor({ timeout: 30000 });
  await page.getByLabel('Message', { exact: true }).fill('wire capture hello');
  await page.getByLabel('Send message').click();
  await page.waitForTimeout(4000);

  // Give pool/dm surfaces their own traffic too: typing indicator + a second
  // message so multiple kind-9s and any control kinds hit the wire.
  await page.getByLabel('Message', { exact: true }).fill('second capture line');
  await page.getByLabel('Send message').click();
  await page.waitForTimeout(4000);

  console.log(`frames recorded: ${seqN}; pins seen: ${pinsSeen.size}`);
  fs.writeFileSync(`${CAPTURE_PREFIX}-pins.txt`, [...pinsSeen].join(','));
  console.log(`written: ${captureFile} / ${CAPTURE_PREFIX}-pins.txt`);
} finally {
  await browser.close();
  httpServer.close();
  wsServer.close();
}
process.exit(0);

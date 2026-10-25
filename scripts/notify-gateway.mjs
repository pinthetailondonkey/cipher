// A push box you run. Cipher does not start this.
//
//   node scripts/notify-gateway.mjs
//
// Paste the printed address into Connections → Push gateway.
// The box stores a VAPID key and the phone subscriptions under ./data/push-gateway.
// It watches CIPHER_RELAYS (default the message relay) for kind-4 events and
// sends { "kind": "message" }. It does not decrypt them.
// Registration is open: anyone with this box's URL can register any pubkey and learn when that key receives a message.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { SimplePool } from 'nostr-tools';
import { eventShouldBuzz, eventShouldOrder, eventShouldRing } from '../src/lib/pushGateway.js';
import { nativeRegistration, sendNative } from '../src/lib/nativePushSend.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.PUSH_PORT || 8787);
const dir = process.env.CIPHER_PUSH_DIR || path.join(process.cwd(), 'data', 'push-gateway');
const relays = (process.env.CIPHER_RELAYS || 'wss://relay.primal.net').split(',').map((item) => item.trim()).filter(Boolean);
const statePath = path.join(dir, 'state.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { publicKey: '', privateKey: '', subs: [], native: [] };
  }
}

function save(state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

const state = load();
if (!Array.isArray(state.subs)) state.subs = [];
if (!Array.isArray(state.native)) state.native = [];
const recent = new Map();

let webpush;
try {
const imported = await import('web-push');
webpush = imported.default || imported;
} catch {
  console.error('[push] Install web-push first: npm install web-push');
  process.exit(1);
}

if (!state.publicKey || !state.privateKey) {
  const keys = webpush.generateVAPIDKeys();
  state.publicKey = keys.publicKey;
  state.privateKey = keys.privateKey;
  save(state);
}
webpush.setVapidDetails('mailto:cipher@localhost', state.publicKey, state.privateKey);

async function notify(pubkey, kind) {
  const recentKey = `${pubkey}:${kind}`;
  const last = recent.get(recentKey) || 0;
  if (Date.now() - last < 15000) return;
  recent.set(recentKey, Date.now());
  const notice = kind === 'order' || kind === 'call' ? kind : 'message';
  const targets = state.subs.filter((row) => row.pubkey === pubkey);
  const native = (state.native || []).filter((row) => row.pubkey === pubkey);
  await Promise.all(native.map(async (row) => {
    try {
      const result = await sendNative({ transport: row.transport, token: row.token, kind: notice });
      if (!result.sent) console.error(`[push] ${result.reason}`);
    } catch (error) {
      console.error('[push] Native delivery failed:', error?.message);
    }
  }));
  await Promise.all(targets.map(async (row) => {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify({ kind: notice }));
    } catch (error) {
      console.error('[push] Delivery failed:', error?.statusCode || error?.message);
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        state.subs = state.subs.filter((item) => item !== row);
        save(state);
      }
    }
  }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/cipher-push.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ vapidPublicKey: state.publicKey }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/subscribe') {
    try {
      const body = await readBody(req);
      if (!body?.pubkey || !body?.subscription?.endpoint) throw new Error('A subscription needs a pubkey and an endpoint.');
      state.subs = state.subs.filter((row) => row.subscription?.endpoint !== body.subscription.endpoint);
      state.subs.push({ pubkey: body.pubkey, subscription: body.subscription });
      save(state);
      watch();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      console.error('[push] Subscribe failed:', error.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/native') {
    try {
      const body = await readBody(req);
      if (!body?.pubkey || !body?.token) throw new Error('A native subscription needs a pubkey and a token.');
      if (body.transport !== 'fcm' && body.transport !== 'apns') throw new Error('Native push is FCM or APNs.');
      state.native = state.native.filter((row) => row.token !== body.token);
      state.native.push({ pubkey: body.pubkey, transport: body.transport, token: body.token });
      save(state);
      watch();
      const tokenStored = load().native.some((row) => row.token === body.token && row.transport === body.transport);
      const { buzzing, reason } = nativeRegistration({ transport: body.transport, tokenStored });
      console.error(`[push] ${reason}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, buzzing, reason }));
    } catch (error) {
      console.error('[push] Native subscribe failed:', error.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

const pool = new SimplePool();
let closer = () => {};

function watch() {
  try { closer(); } catch { /* the previous socket is already gone */ }
  const authors = [...new Set([
    ...state.subs.map((row) => row.pubkey),
    ...(state.native || []).map((row) => row.pubkey),
  ].filter(Boolean))];
  if (!authors.length || !relays.length) return;
  const sub = pool.subscribeMany(relays, { kinds: [4], '#p': authors, '#t': ['msg', 'order', 'call'] }, {
    onevent(event) {
      const kind = eventShouldRing(event) ? 'call' : eventShouldOrder(event) ? 'order' : eventShouldBuzz(event) ? 'message' : null;
      if (!kind) return;
      const who = event.tags?.find((tag) => tag[0] === 'p')?.[1];
      if (who) notify(who, kind).catch((error) => console.error('[push]', error.message));
    },
  });
  closer = () => sub.close();
}

server.listen(port, '0.0.0.0', () => {
  console.log(`[push] http://127.0.0.1:${port}`);
  console.log('[push] Paste that address into Connections. Nothing buzzes until a phone subscribes.');
  watch();
});

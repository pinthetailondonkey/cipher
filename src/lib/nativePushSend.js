import crypto from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';
import { EGRESS } from './egress.js';

function egressUrl(id) {
  const entry = EGRESS.find((row) => row.id === id);
  if (!entry?.url) throw new Error(`The push host ${id} is not listed.`);
  return String(entry.url).replace(/\/$/, '');
}

function b64url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString('base64url');
}

export function noticeFor(kind) {
  // A forged t tag on a relay is all a stranger needs to spend "Incoming
  // call" or "New order" on a locked phone, so the title says only what
  // every buzz can prove. The kind still rides along for the counters.
  // (security S11 re-attack)
  if (kind === 'call' || kind === 'order' || kind === 'message') return { title: 'New message', kind };
  return null;
}

export function keysReady(env = process.env) {
  const fcmPath = String(env.FCM_SERVICE_ACCOUNT || '');
  const apnsPath = String(env.APNS_KEY_PATH || '');
  return {
    fcm: Boolean(fcmPath && fs.existsSync(fcmPath)),
    apns: Boolean(apnsPath && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC && fs.existsSync(apnsPath)),
  };
}

// What the box can honestly say to a phone that registered a native token.
// True means the token is stored and the key file is present, so this box will
// send. It does not mean a locked phone has been seen to buzz.
export function nativeRegistration({ transport, tokenStored, env = process.env } = {}) {
  if (!tokenStored) return { buzzing: false, reason: 'The token was not stored, so the installed app does not notify.' };
  const ready = keysReady(env);
  if (transport === 'fcm' && ready.fcm) {
    return { buzzing: true, reason: 'The token is stored and the Firebase key is present, so this box sends through FCM. A locked phone has not been confirmed to buzz.' };
  }
  if (transport === 'apns' && ready.apns) {
    return { buzzing: true, reason: 'The token is stored and the APNs key is present, so this box sends through APNs. A locked phone has not been confirmed to buzz.' };
  }
  if (transport === 'fcm') return { buzzing: false, reason: 'The token is stored. FCM_SERVICE_ACCOUNT is missing or not a file, so the installed app does not notify.' };
  if (transport === 'apns') return { buzzing: false, reason: 'The token is stored. APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, or APNS_TOPIC is missing, so the installed app does not notify.' };
  return { buzzing: false, reason: 'That token is neither FCM nor APNs.' };
}

export function serviceAccountJwt(account, { scope, aud, now = Math.floor(Date.now() / 1000) }) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: account.client_email,
    scope,
    aud,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(account.private_key);
  return `${unsigned}.${b64url(signature)}`;
}

export function apnsJwt({ key, keyId, teamId }, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claim = b64url(JSON.stringify({ iss: teamId, iat: now }));
  const unsigned = `${header}.${claim}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${b64url(signature)}`;
}

export async function sendFcm({ account, token, kind, fetchImpl = globalThis.fetch, now }) {
  const notice = noticeFor(kind);
  if (!notice) return { sent: false, reason: 'That event does not buzz.' };
  const assertion = serviceAccountJwt(account, {
    scope: `${egressUrl('fcm-scope')}/auth/firebase.messaging`,
    aud: `${egressUrl('fcm-auth')}/token`,
    now,
  });
  const tokenResponse = await fetchImpl(`${egressUrl('fcm-auth')}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}`,
  });
  const tokenBody = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenBody.access_token) {
    throw new Error(tokenBody.error_description || 'Google did not grant a push token.');
  }
  const project = account.project_id;
  const sent = await fetchImpl(`${egressUrl('fcm')}/v1/projects/${project}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenBody.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: notice.title, body: notice.title },
        data: { kind: notice.kind },
      },
    }),
  });
  if (!sent.ok) throw new Error(`FCM refused the notice (${sent.status}).`);
  return { sent: true, transport: 'fcm' };
}

function apnsRequest({ host, token, jwt, topic, body }) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(host);
    client.on('error', reject);
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    });
    const chunks = [];
    req.on('response', (headers) => {
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        client.close();
        resolve({ status: Number(headers[':status'] || 0), body: Buffer.concat(chunks).toString() });
      });
    });
    req.on('error', (error) => {
      client.close();
      reject(error);
    });
    req.end(body);
  });
}

export async function sendApns({ key, keyId, teamId, topic, token, kind, host, requestImpl = apnsRequest, now }) {
  const notice = noticeFor(kind);
  if (!notice) return { sent: false, reason: 'That event does not buzz.' };
  const jwt = apnsJwt({ key, keyId, teamId }, now);
  const body = JSON.stringify({ aps: { alert: { title: notice.title }, sound: 'default' }, kind: notice.kind });
  const result = await requestImpl({ host, token, jwt, topic, body });
  if (result.status !== 200) throw new Error(`APNs refused the notice (${result.status}).`);
  return { sent: true, transport: 'apns' };
}

export async function sendNative({ transport, token, kind, env = process.env, fetchImpl, requestImpl } = {}) {
  const notice = noticeFor(kind);
  if (!notice) return { sent: false, reason: 'Typing and receipts are not sent.' };
  const ready = keysReady(env);
  if (transport === 'fcm') {
    if (!ready.fcm) return { sent: false, reason: 'FCM_SERVICE_ACCOUNT is not set. The installed app was not told.' };
    const account = JSON.parse(fs.readFileSync(env.FCM_SERVICE_ACCOUNT, 'utf8'));
    return sendFcm({ account, token, kind: notice.kind, fetchImpl });
  }
  if (transport === 'apns') {
    if (!ready.apns) return { sent: false, reason: 'APNS_KEY_PATH is not set. The installed app was not told.' };
    const key = fs.readFileSync(env.APNS_KEY_PATH, 'utf8');
    return sendApns({
      key,
      keyId: env.APNS_KEY_ID,
      teamId: env.APNS_TEAM_ID,
      topic: env.APNS_TOPIC,
      token,
      kind: notice.kind,
      host: env.APNS_HOST || egressUrl('apns'),
      requestImpl,
    });
  }
  return { sent: false, reason: 'That token is neither FCM nor APNs.' };
}

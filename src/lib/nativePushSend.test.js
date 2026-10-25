import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apnsJwt, nativeRegistration, noticeFor, sendApns, sendFcm, sendNative, serviceAccountJwt } from './nativePushSend.js';

test('a native notice is only a message or a call, and it is not sent without a key', async () => {
  assert.equal(noticeFor('typing'), null);
  assert.equal(noticeFor('message').title, 'New message');
  assert.equal(noticeFor('call').kind, 'call');
  const missing = await sendNative({ transport: 'fcm', token: 'device', kind: 'message', env: {} });
  assert.equal(missing.sent, false);
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const account = { client_email: 'push@cipher.iam.gserviceaccount.com', private_key: pem, project_id: 'cipher-push' };
  const jwt = serviceAccountJwt(account, {
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    now: 1_700_000_000,
  });
  assert.equal(jwt.split('.').length, 3);
  const calls = [];
  const sent = await sendFcm({
    account,
    token: 'device-token',
    kind: 'message',
    now: 1_700_000_000,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options.body });
      if (String(url).includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'ya29' }) };
      return { ok: true, status: 200, json: async () => ({ name: 'projects/cipher-push/messages/1' }) };
    },
  });
  assert.equal(sent.sent, true);
  const message = JSON.parse(calls[1].body).message;
  assert.equal(message.token, 'device-token');
  assert.equal(message.data.kind, 'message');
  assert.equal(JSON.stringify(message).includes('hello'), false);
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const apple = apnsJwt({ key: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'KEYID', teamId: 'TEAM' }, 1_700_000_000);
  assert.equal(apple.split('.').length, 3);
  let apnsBody;
  const ring = await sendApns({
    key: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    keyId: 'KEYID',
    teamId: 'TEAM',
    topic: 'app.cipher',
    token: 'apple-token',
    kind: 'call',
    now: 1_700_000_000,
    requestImpl: async ({ body, topic }) => {
      apnsBody = { body, topic };
      return { status: 200, body: '' };
    },
  });
  assert.equal(ring.sent, true);
  assert.equal(apnsBody.topic, 'app.cipher');
  assert.equal(JSON.parse(apnsBody.body).kind, 'call');
});

test('buzzing is true only when the token is stored and the key file is present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-push-'));
  const keyFile = path.join(dir, 'key.json');
  fs.writeFileSync(keyFile, '{}');
  const fcmEnv = { FCM_SERVICE_ACCOUNT: keyFile };
  const apnsEnv = { APNS_KEY_PATH: keyFile, APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_TOPIC: 'app' };
  const ready = nativeRegistration({ transport: 'fcm', tokenStored: true, env: fcmEnv });
  assert.equal(ready.buzzing, true);
  assert.match(ready.reason, /has not been confirmed to buzz/);
  assert.equal(nativeRegistration({ transport: 'apns', tokenStored: true, env: apnsEnv }).buzzing, true);
  assert.equal(nativeRegistration({ transport: 'fcm', tokenStored: false, env: fcmEnv }).buzzing, false);
  const noKey = nativeRegistration({ transport: 'fcm', tokenStored: true, env: {} });
  assert.equal(noKey.buzzing, false);
  assert.match(noKey.reason, /FCM_SERVICE_ACCOUNT/);
  assert.equal(nativeRegistration({ transport: 'fcm', tokenStored: true, env: { FCM_SERVICE_ACCOUNT: path.join(dir, 'gone.json') } }).buzzing, false);
  assert.equal(nativeRegistration({ transport: 'apns', tokenStored: true, env: { ...apnsEnv, APNS_TOPIC: '' } }).buzzing, false);
  assert.equal(nativeRegistration({ transport: 'apns', tokenStored: true, env: fcmEnv }).buzzing, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

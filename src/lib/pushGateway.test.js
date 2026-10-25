import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { eventShouldBuzz, eventShouldRing, nativeTransport, notificationFromPush, payloadShouldBuzz, registerWithGateway, withBuzzTag } from './pushGateway.js';

test('typing, read receipts, and key bundles are not tagged, so they do not buzz', () => {
  assert.equal(payloadShouldBuzz({ type: 'typing' }), false);
  assert.equal(payloadShouldBuzz({ type: 'read', at: 1 }), false);
  assert.equal(payloadShouldBuzz({ t: 'gkey', gid: 'g', keys: [] }), false);
  const typing = withBuzzTag([['p', 'aa']], { type: 'typing' });
  assert.equal(typing.some((tag) => tag[0] === 't'), false);
  assert.equal(eventShouldBuzz({ tags: typing }), false);
  const call = withBuzzTag([['p', 'aa']], { type: 'call', state: 'ringing' });
  assert.equal(call.some((tag) => tag[0] === 't' && tag[1] === 'call'), true);
  assert.equal(call.some((tag) => tag[1] === 'msg'), false);
  assert.equal(eventShouldRing({ tags: call }), true);
  assert.equal(eventShouldBuzz({ tags: call }), false);
  const message = withBuzzTag([['p', 'aa']], { message: 'hello' });
  assert.equal(eventShouldBuzz({ tags: message }), true);
  const order = withBuzzTag([['p', 'aa']], { type: 'order_request' });
  assert.equal(eventShouldBuzz({ tags: order }), true);
});

test('a push notice never carries the message', () => {
  assert.deepEqual(notificationFromPush({ kind: 'message', body: 'the secret drop is at 4th' }), {
    title: 'New message',
    body: 'Open Cipher to view it.',
    data: { kind: 'message' },
  });
  assert.equal(notificationFromPush({ kind: 'order', text: '2g of whatever' }).title, 'New order');
  assert.equal(notificationFromPush({ kind: 'call', state: 'ringing' }).title, 'Incoming call');
  assert.equal(notificationFromPush('meet at the corner').body, 'Open Cipher to view it.');
  const sw = fs.readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
  assert.equal(sw.includes('event.data.text'), false);
  assert.match(sw, /Open Cipher to view it/);
});

test('no gateway means no request, and a gateway that answers can register', async () => {
  let calls = 0;
  const silent = await registerWithGateway({ gatewayUrl: '', pubkey: 'aa', fetchImpl: async () => { calls += 1; } });
  assert.equal(silent.buzzing, false);
  assert.equal(calls, 0);
  assert.equal(nativeTransport('android'), 'fcm');
  assert.equal(nativeTransport('ios'), 'apns');
  assert.equal(nativeTransport('web'), null);
  let nativeBody = null;
  const native = await registerWithGateway({
    gatewayUrl: 'https://push.example/ignored',
    pubkey: 'aa',
    fetchImpl: async (url, options) => {
      nativeBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ ok: true, buzzing: false, reason: 'no key' }) };
    },
    native: async () => ({ platform: 'android', token: 'device-token' }),
  });
  assert.equal(native.buzzing, false);
  assert.equal(native.transport, 'fcm');
  assert.equal(nativeBody.transport, 'fcm');
  assert.equal(nativeBody.token, 'device-token');
  const urls = [];
  const registered = await registerWithGateway({
    gatewayUrl: 'https://push.example/ignored',
    pubkey: 'aa'.repeat(32),
    fetchImpl: async (url, options) => {
      urls.push(String(url));
      if (String(url).endsWith('/cipher-push.json')) {
        return { ok: true, json: async () => ({ vapidPublicKey: 'abc' }) };
      }
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      assert.equal(body.transport, 'webpush');
      assert.equal(JSON.stringify(body).includes('secret'), false);
      return { ok: true, json: async () => ({ ok: true }) };
    },
    subscribe: async (key) => ({ endpoint: 'https://push.example/device', key }),
  });
  assert.equal(registered.buzzing, true);
  assert.deepEqual(urls, ['https://push.example/cipher-push.json', 'https://push.example/subscribe']);
});

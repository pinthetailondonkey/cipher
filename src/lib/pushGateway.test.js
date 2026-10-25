import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { eventShouldBuzz, notificationFromPush, payloadShouldBuzz, registerWithGateway, withBuzzTag } from './pushGateway.js';

test('typing, read receipts, and key bundles are not tagged, so they do not buzz', () => {
  assert.equal(payloadShouldBuzz({ type: 'typing' }), false);
  assert.equal(payloadShouldBuzz({ type: 'read', at: 1 }), false);
  assert.equal(payloadShouldBuzz({ t: 'gkey', gid: 'g', keys: [] }), false);
  assert.equal(payloadShouldBuzz({ type: 'call', state: 'ringing' }), false);
  const typing = withBuzzTag([['p', 'aa']], { type: 'typing' });
  assert.equal(typing.some((tag) => tag[0] === 't'), false);
  assert.equal(eventShouldBuzz({ tags: typing }), false);
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

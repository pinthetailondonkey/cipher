import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createLocalNip01Relay } from './local-nip01-relay.mjs';

const relay = await createLocalNip01Relay({
  requireAuth: true,
  deliveryDelayMs: 70,
  authChallengeForConnection: (connectionId) => `local-fault-test-challenge-${connectionId}`,
});
let browser;
const pages = [];

async function openClient(label) {
  const page = await browser.newPage();
  pages.push(page);
  await page.setContent('<!doctype html><html><body>local relay fault probe</body></html>');
  await page.evaluate((url) => {
    const client = { messages: [], socket: new WebSocket(url) };
    client.socket.addEventListener('message', (event) => client.messages.push(JSON.parse(event.data)));
    window.localRelayClient = client;
  }, relay.url);
  await page.waitForFunction(() => window.localRelayClient.socket.readyState === WebSocket.OPEN
    && window.localRelayClient.messages.some((frame) => frame[0] === 'AUTH'));
  const challenge = await page.evaluate(() => window.localRelayClient.messages.find((frame) => frame[0] === 'AUTH')[1]);
  return { label, page, challenge };
}

async function authenticate(client, secretKey, challenge = client.challenge) {
  const event = finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000),
    tags: [['relay', relay.url], ['challenge', challenge]], content: '' }, secretKey);
  await client.page.evaluate((signed) => {
    window.localRelayClient.socket.send(JSON.stringify(['AUTH', signed]));
  }, event);
  await client.page.waitForFunction((id) => window.localRelayClient.messages.some((frame) =>
    frame[0] === 'OK' && frame[1] === id), event.id);
  const response = await client.page.evaluate((id) => window.localRelayClient.messages.find((frame) =>
    frame[0] === 'OK' && frame[1] === id), event.id);
  return { event, response };
}

async function sendFrame(client, frame) {
  await client.page.evaluate((value) => window.localRelayClient.socket.send(JSON.stringify(value)), frame);
}

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for local relay fault fixture state.');
}

try {
  browser = await chromium.launch({ headless: true });
  const subscriberSecret = generateSecretKey();
  const senderSecret = generateSecretKey();
  const routePubkey = getPublicKey(generateSecretKey());
  const subscriber = await openClient('subscriber');
  const subscriberAuth = await authenticate(subscriber, subscriberSecret);
  assert.equal(subscriberAuth.response[2], true, 'valid NIP-42 challenge must authenticate');

  await sendFrame(subscriber, ['REQ', 'route-sub', { kinds: [14], '#p': [routePubkey] }]);
  await subscriber.page.waitForFunction(() => window.localRelayClient.messages.some((frame) => frame[0] === 'EOSE'));

  const sender = await openClient('sender');
  const senderAuth = await authenticate(sender, senderSecret);
  assert.equal(senderAuth.response[2], true, 'second connection must authenticate against its own challenge');
  assert.notEqual(sender.challenge, subscriber.challenge, 'each connection must receive a distinct challenge');

  const blocked = await openClient('unauthenticated');
  const wrongAuth = await authenticate(blocked, generateSecretKey(), 'not-the-relay-challenge');
  assert.equal(wrongAuth.response[2], false, 'wrong challenge must be rejected');
  await sendFrame(blocked, ['REQ', 'blocked-sub', { kinds: [14] }]);
  await blocked.page.waitForFunction(() => window.localRelayClient.messages.some((frame) =>
    frame[0] === 'CLOSED' && frame[1] === 'blocked-sub'));

  const makeEvent = (content) => finalizeEvent({ kind: 14, created_at: Math.floor(Date.now() / 1000),
    tags: [['p', routePubkey]], content }, senderSecret);
  const observed = () => subscriber.page.evaluate(() => window.localRelayClient.messages
    .filter((frame) => frame[0] === 'EVENT' && frame[1] === 'route-sub')
    .map((frame) => frame[2].id));

  relay.pauseDeliveries();
  const first = makeEvent('ciphertext-first');
  const second = makeEvent('ciphertext-second');
  for (const event of [first, second]) {
    await sendFrame(sender, ['EVENT', event]);
    await sender.page.waitForFunction((id) => window.localRelayClient.messages.some((frame) =>
      frame[0] === 'OK' && frame[1] === id && frame[2] === true), event.id);
  }
  assert.deepEqual(await observed(), [], 'paused deliveries must remain queued');
  assert.equal(relay.resumeDeliveries({ reverse: true }), 2);
  await subscriber.page.waitForFunction((ids) => {
    const got = window.localRelayClient.messages.filter((frame) => frame[0] === 'EVENT' && frame[1] === 'route-sub')
      .map((frame) => frame[2].id);
    return ids.every((id) => got.includes(id));
  }, [first.id, second.id]);
  assert.deepEqual((await observed()).slice(0, 2), [second.id, first.id], 'held deliveries must be flushable in reverse order');

  const delayed = makeEvent('ciphertext-delayed');
  const acceptedAt = Date.now();
  await sendFrame(sender, ['EVENT', delayed]);
  await sender.page.waitForFunction((id) => window.localRelayClient.messages.some((frame) =>
    frame[0] === 'OK' && frame[1] === id && frame[2] === true), delayed.id);
  await subscriber.page.waitForFunction((id) => window.localRelayClient.messages.some((frame) =>
    frame[0] === 'EVENT' && frame[2]?.id === id), delayed.id);
  const deliveryFrame = relay.frames.find((entry) => entry.direction === 'relay'
    && entry.frame?.[0] === 'EVENT' && entry.frame[2]?.id === delayed.id);
  assert.ok(deliveryFrame && deliveryFrame.atMs - acceptedAt >= 50, 'delivery delay must be recorded and observed');

  const uncertain = makeEvent('ciphertext-lost-ack');
  relay.dropAcknowledgementOnce(uncertain.id);
  await sendFrame(sender, ['EVENT', uncertain]);
  await waitUntil(() => relay.frames.some((entry) => entry.direction === 'test-fault'
    && entry.frame?.[0] === 'TEST_DROP_ACK' && entry.frame[1] === uncertain.id));
  const noAckYet = await sender.page.evaluate((id) => window.localRelayClient.messages.some((frame) =>
    frame[0] === 'OK' && frame[1] === id), uncertain.id);
  assert.equal(noAckYet, false, 'first accepted event should have its ACK dropped');
  assert.equal(relay.events.has(uncertain.id), true, 'relay stores accepted event despite dropped ACK');
  const exactBytes = JSON.stringify(['EVENT', uncertain]);
  await sendFrame(sender, ['EVENT', uncertain]);
  await sender.page.waitForFunction((id) => window.localRelayClient.messages.some((frame) =>
    frame[0] === 'OK' && frame[1] === id && frame[2] === true), uncertain.id);
  const attempts = relay.frames.filter((entry) => entry.direction === 'client'
    && entry.connectionId === relay.connections[1].connectionId
    && entry.frame?.[0] === 'EVENT' && entry.frame[1]?.id === uncertain.id);
  assert.equal(attempts.length, 2, 'lost acknowledgement retry must reach relay twice');
  assert.deepEqual(attempts.map((entry) => JSON.stringify(entry.frame)), [exactBytes, exactBytes],
    'uncertain retry must preserve the exact signed event bytes');

  assert.equal(relay.connections.length, 3);
  assert.ok(relay.connections.every((connection) => connection.remoteAddress && Number.isInteger(connection.remotePort)),
    'connection log must include source address and port');
  assert.ok(relay.frames.filter((entry) => entry.direction === 'client' || entry.direction === 'relay')
    .every((entry) => entry.connectionId && entry.remoteAddress && Number.isInteger(entry.remotePort)),
  'frame log must bind each frame to its observed connection endpoint');
  process.stdout.write('Local relay fault harness passed: per-connection NIP-42 AUTH, auth refusal, delayed delivery, reordered delivery, dropped ACK with exact-event retry, and endpoint logging.\n');
} finally {
  for (const page of pages) await page.close().catch(() => {});
  await browser?.close();
  await relay.close();
}

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { createLocalNip01Relay } from './local-nip01-relay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relay = await createLocalNip01Relay();
process.env.VITE_TEST_HOOKS = '1';
process.env.CIPHER_UI_TEST_BUILD = '1';
const vite = await createViteServer({
  configFile: path.join(root, 'vite.config.js'),
  server: { host: '127.0.0.1', port: 8099, strictPort: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: ['dexie', 'react', 'react-dom/client'] },
});
vite.middlewares.use((request, response, next) => {
  if (request.url !== '/__dm_local_relay_test') return next();
  const html = '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/lib/dmLocalRelayProbe.jsx"></script></body></html>';
  vite.transformIndexHtml(request.url, html).then((transformed) => {
    response.setHeader('content-type', 'text/html');
    response.end(transformed);
  }).catch(next);
});

let browser;
let contextA;
let contextB;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  const relayConfig = JSON.stringify({ overrides: {
    'dm-relay': relay.url,
    'profile-nos': relay.url,
    'profile-damus': relay.url,
    'group-relay': relay.url,
    'group-relay-2': relay.url,
    'search-vertex': relay.url,
    'search-noswhere': relay.url,
  }, lists: { dm: [], profile: [] } });
  const instrument = `(() => {
    localStorage.setItem('cipher_network', ${JSON.stringify(relayConfig)});
    window.__webSocketSent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function sendCaptured(data) {
      let frame = null;
      try { frame = JSON.parse(typeof data === 'string' ? data : ''); } catch { /* binary/control frame */ }
      window.__webSocketSent.push({ at: performance.now(), atWallClockMs: Date.now(), url: this.url,
        readyState: this.readyState, frame });
      return send.call(this, data);
    };
  })();`;
  contextA = await browser.newContext();
  contextB = await browser.newContext();
  await Promise.all([contextA, contextB].map((context) => context.addInitScript(instrument)));
  const a = await contextA.newPage();
  const b = await contextB.newPage();
  for (const [label, page] of [['sender', a], ['receiver', b]]) {
    page.on('pageerror', (error) => console.error(`[${label}]`, error));
    page.on('console', (message) => { if (message.type() === 'error') console.error(`[${label} console]`, message.text()); });
    page.on('response', (response) => { if (response.status() >= 400) console.error(`[${label} HTTP ${response.status()}]`, response.url()); });
  }
  await Promise.all([a, b].map((page) => page.goto('http://127.0.0.1:8099/__dm_local_relay_test', { waitUntil: 'commit' })));
  await Promise.all([a, b].map((page) => page.waitForFunction(() => window.__identity && !window.__identity.loadingSession,
    null, { timeout: 60_000 }).catch(async (error) => {
      const state = await page.evaluate(() => ({ url: location.href, title: document.title,
        root: document.getElementById('root')?.innerText, identity: !!window.__identity,
        loading: window.__identity?.loadingSession }));
      throw new Error(`Test app did not mount: ${JSON.stringify(state)} (${error.message})`);
    })));
  const [restoredA, restoredB] = await Promise.all([
    a.evaluate(() => window.__identity.restoreFromMnemonic(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '12345678')),
    b.evaluate(() => window.__identity.restoreFromMnemonic(
      'legal winner thank year wave sausage worth useful legal winner thank yellow', '87654321')),
  ]);
  if (!restoredA.success || !restoredB.success) throw new Error('Could not restore the two synthetic relay-test accounts.');
  await Promise.all([a, b].map((page) => page.waitForFunction(() => window.__identity.pk && window.__identity.securityFence?.isCurrent())));
  const configuredRelays = await a.evaluate(async () => {
    const { generalRelays } = await import('/src/lib/relays.js');
    return { configured: localStorage.getItem('cipher_network'), general: generalRelays.slice() };
  });
  if (!configuredRelays.general.includes(relay.url)) {
    throw new Error(`The browser test override did not route app relays to loopback: ${JSON.stringify(configuredRelays)}`);
  }
  const [alice, bob] = await Promise.all([a, b].map((page) => page.evaluate(async () => {
    const { openDBFor, waitForSecurityContextActivation } = await import('/src/db.js');
    openDBFor(window.__identity.pk, window.__identity.securityFence);
    await waitForSecurityContextActivation();
    // Giftwrap relay timestamps are deliberately backdated; start history
    // before that window so this synthetic inbox subscription observes it.
    window.__stopDmSubscription = window.__dm.subscribeToDMs(Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60);
    return window.__identity.pk;
  })));
  if (alice === bob) throw new Error('The local relay test clients must be distinct accounts.');

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const requests = relay.frames.filter(({ direction, frame }) => direction === 'client' && frame?.[0] === 'REQ');
    if (requests.length >= 4) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (relay.frames.filter(({ direction, frame }) => direction === 'client' && frame?.[0] === 'REQ').length < 4) {
    throw new Error('Both app clients did not establish their incoming DM subscriptions on the local relay.');
  }

  const body = 'synthetic local relay app-path DM';
  const send = await a.evaluate(async (peer) => {
    const result = await window.__dm.sendDM(peer, { type: 'text', message: 'synthetic local relay app-path DM' });
    return { success: result.success, queued: !!result.queued, error: result.error,
      event: result.event, sent: window.__webSocketSent };
  }, bob);
  if (!send.success || send.queued || !send.event?.id || send.event.kind !== 1059) {
    throw new Error(`The ordinary app DM path did not receive a local relay acknowledgement: ${JSON.stringify(send)}`);
  }
  await b.waitForFunction((peer) => window.__chatStore.getState().dms?.[peer]
    ?.some((message) => message.data?.message === 'synthetic local relay app-path DM'), alice, { timeout: 15_000 })
    .catch(async (error) => {
      const state = await b.evaluate((peer) => ({ peer, messages: window.__chatStore.getState().dms?.[peer] || [],
        socketFrames: (window.__webSocketSent || []).map(({ frame, readyState }) => ({ type: frame?.[0], readyState,
          kind: frame?.[0] === 'EVENT' ? frame[1]?.kind : undefined,
          id: frame?.[0] === 'EVENT' ? frame[1]?.id : frame?.[1] })) }), alice);
      const relayFrames = relay.frames.map(({ direction, frame, message }) => ({ direction, message,
        type: frame?.[0], kind: frame?.[0] === 'EVENT' ? frame[1]?.kind : undefined,
        id: frame?.[0] === 'EVENT' ? frame[1]?.id : frame?.[1],
        routeCount: frame?.[0] === 'EVENT' ? frame[1]?.tags?.filter((tag) => tag[0] === 'p').length : undefined }));
      throw new Error(`The receiver app hook did not ingest the local relay DM: ${JSON.stringify({ state,
        relayFrames, relayEventIds: Array.from(relay.events.keys()), cause: error.message })}`);
    });

  const relayEvent = relay.events.get(send.event.id);
  if (!relayEvent || !relayEvent.tags.some((tag) => tag[0] === 'p' && tag[1] === bob)) {
    throw new Error('The relay did not capture the signed NIP-59 event routed to the synthetic recipient.');
  }
  if (JSON.stringify(relayEvent).includes(body)) throw new Error('The relay-visible NIP-59 event contained application plaintext.');
  if (relayEvent.pubkey === alice) throw new Error('The relay-visible wrapper exposed the sender account key.');
  const actualSocketEvent = send.sent.findLast((item) => item.frame?.[0] === 'EVENT' && item.frame[1]?.id === send.event.id);
  if (!actualSocketEvent || actualSocketEvent.readyState !== 1) {
    throw new Error('No actual open-WebSocket EVENT handoff was captured from the app path.');
  }

  // Exercise the isolated R5 transaction and delivery prototype with two
  // independently enrolled synthetic accounts. The ratchet ciphertext/state
  // are fixtures here; this checks authority binding, atomic commit, NIP-59
  // transport, receiver proof validation, and the actual browser socket only.
  await a.evaluate(async () => {
    const { createDeviceAuthoritySetup } = await import('/src/lib/deviceAuthority.js');
    const identity = window.__identity;
    const state = createDeviceAuthoritySetup({ accountPubkey: identity.pk, now: Math.floor(Date.now() / 1000) });
    window.__senderAuthority = state;
    return { accountPubkey: JSON.parse(state.policyEvent.content).accountPubkey,
      recoveryPubkey: JSON.parse(state.policyEvent.content).recoveryPubkey,
      policyEvent: state.policyEvent, policyId: state.policyEvent.id,
      registryEvent: state.registryEvent, registryId: state.registryEvent.id,
      registryHistory: [state.registryEvent],
      deviceId: state.primaryDevice.deviceId, devicePubkey: state.primaryDevice.devicePubkey };
  });
  const recipientAuthority = await b.evaluate(async () => {
    const { createDeviceAuthoritySetup } = await import('/src/lib/deviceAuthority.js');
    const identity = window.__identity;
    const state = createDeviceAuthoritySetup({ accountPubkey: identity.pk, now: Math.floor(Date.now() / 1000) });
    window.__recipientAuthority = state;
    return { accountPubkey: JSON.parse(state.policyEvent.content).accountPubkey,
      recoveryPubkey: JSON.parse(state.policyEvent.content).recoveryPubkey,
      policyEvent: state.policyEvent, policyId: state.policyEvent.id,
      registryEvent: state.registryEvent, registryId: state.registryEvent.id,
      registryHistory: [state.registryEvent],
      deviceId: state.primaryDevice.deviceId, devicePubkey: state.primaryDevice.devicePubkey };
  });
  const sendAuthorization = await a.evaluate(async ({ recipient, relayUrl }) => {
    const { createRatchetOperationId } = await import('/src/lib/dmRatchetAuthority.js');
    const { createDeviceFreshnessChallengeV2, buildDeviceFreshnessResponseV2 } = await import('/src/lib/deviceAuthority.js');
    const state = window.__senderAuthority;
    const now = Math.floor(Date.now() / 1000);
    const operationId = createRatchetOperationId();
    const senderChallenge = createDeviceFreshnessChallengeV2({ policyEvent: state.policyEvent,
      registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
      requesterDeviceSecret: state.primaryDevice.deviceSecret, requesterDeviceId: state.primaryDevice.deviceId,
      targetDeviceId: state.primaryDevice.deviceId, purpose: 'send-dm', operationId, now });
    const senderResponse = buildDeviceFreshnessResponseV2({ policyEvent: state.policyEvent,
      registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
      challengeEvent: senderChallenge, authoritySecret: state.authoritySecret, now });
    return { operationId, sender: { checkpoint: {
      accountPubkey: JSON.parse(state.policyEvent.content).accountPubkey,
      recoveryPubkey: JSON.parse(state.policyEvent.content).recoveryPubkey,
      policyEvent: state.policyEvent, policyId: state.policyEvent.id,
      registryEvent: state.registryEvent, registryId: state.registryEvent.id,
      registryHistory: [state.registryEvent],
    }, deviceId: state.primaryDevice.deviceId, requesterDeviceId: state.primaryDevice.deviceId,
    challengeEvent: senderChallenge, responseEvent: senderResponse }, recipient, relayUrl };
  }, { recipient: recipientAuthority, relayUrl: relay.url });
  const recipientProof = await b.evaluate(async ({ operationId }) => {
    const { createDeviceFreshnessChallengeV2, buildDeviceFreshnessResponseV2 } = await import('/src/lib/deviceAuthority.js');
    const state = window.__recipientAuthority;
    const now = Math.floor(Date.now() / 1000);
    const challengeEvent = createDeviceFreshnessChallengeV2({ policyEvent: state.policyEvent,
      registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
      requesterDeviceSecret: state.primaryDevice.deviceSecret, requesterDeviceId: state.primaryDevice.deviceId,
      targetDeviceId: state.primaryDevice.deviceId, purpose: 'send-dm', operationId, now });
    const responseEvent = buildDeviceFreshnessResponseV2({ policyEvent: state.policyEvent,
      registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
      challengeEvent, authoritySecret: state.authoritySecret, now });
    return { checkpoint: { accountPubkey: JSON.parse(state.policyEvent.content).accountPubkey,
      recoveryPubkey: JSON.parse(state.policyEvent.content).recoveryPubkey,
      policyEvent: state.policyEvent, policyId: state.policyEvent.id,
      registryEvent: state.registryEvent, registryId: state.registryEvent.id,
      registryHistory: [state.registryEvent] },
      deviceId: state.primaryDevice.deviceId, requesterDeviceId: state.primaryDevice.deviceId,
      challengeEvent, responseEvent };
  }, { operationId: sendAuthorization.operationId });
  const ratchetCommit = await a.evaluate(async ({ sendAuthorization, recipientProof }) => {
    const { authorizeRatchetSend } = await import('/src/lib/dmRatchetAuthority.js');
    const { commitRatchetOutboundV2 } = await import('/src/lib/dmRatchetTransactions.js');
    const state = window.__senderAuthority;
    const authorization = authorizeRatchetSend({ operationId: sendAuthorization.operationId,
      sender: sendAuthorization.sender,
      recipient: { ...recipientProof, checkpoint: recipientProof.checkpoint },
      now: Math.floor(Date.now() / 1000) });
    if (!authorization) throw new Error('Two-account device authority proofs did not authorize the fixture send.');
    const result = await commitRatchetOutboundV2({
      owner: window.__identity.pk, sessionId: 'fixture-session-sender-recipient',
      peerPubkey: recipientProof.checkpoint.accountPubkey, peerDeviceId: recipientProof.deviceId,
      expectedVersion: null, state: { fixtureRatchetState: true, version: 1 },
      ratchetCiphertext: 'fixture-ciphertext-from-no-live-ratchet',
      senderDeviceSecret: state.primaryDevice.deviceSecret,
      // The transaction validates this raw proof bundle itself and derives
      // the immutable event's freshness deadline from the exact checkpoints.
      authorization: { operationId: sendAuthorization.operationId,
        sender: sendAuthorization.sender, recipient: recipientProof },
      securityFence: window.__identity.securityFence, relays: [sendAuthorization.relayUrl],
    });
    const committedEvent = result.event;
    if (!committedEvent) throw new Error('Ratchet transaction did not return its committed immutable event.');
    return { event: committedEvent, operationId: authorization.operationId, freshUntil: authorization.freshUntil };
  }, { sendAuthorization, recipientProof });

  relay.dropAcknowledgementOnce(ratchetCommit.event.id);
  const uncertainAttempt = await a.evaluate(async ({ event, freshUntil, relayUrl }) => {
    const { publishRatchetEventAtProofBoundary } = await import('/src/lib/ratchetProofAwareTransport.js');
    try {
      await publishRatchetEventAtProofBoundary({ url: relayUrl, event, freshUntil,
        assertCurrent: () => window.__identity.securityFence.assertCurrent(), timeoutMs: 250 });
      return { accepted: true };
    } catch (error) { return { accepted: false, error: error.message }; }
  }, { ...ratchetCommit, relayUrl: relay.url });
  if (uncertainAttempt.accepted || !/timed out/i.test(uncertainAttempt.error || '')) {
    throw new Error(`The local relay did not produce the planned uncertain acknowledgement: ${JSON.stringify(uncertainAttempt)}`);
  }
  const openedRatchet = await b.evaluate(async ({ eventId, senderCheckpoint, relayUrl }) => {
    const { openAuthorizedRatchetDm } = await import('/src/lib/dmRatchetAuthority.js');
    const receiver = window.__recipientAuthority;
    const recipientCheckpoint = { accountPubkey: JSON.parse(receiver.policyEvent.content).accountPubkey,
      recoveryPubkey: JSON.parse(receiver.policyEvent.content).recoveryPubkey,
      policyEvent: receiver.policyEvent, policyId: receiver.policyEvent.id,
      registryEvent: receiver.registryEvent, registryId: receiver.registryEvent.id,
      registryHistory: [receiver.registryEvent] };
    const pool = new window.__SimplePool({ enablePing: false, enableReconnect: false });
    try {
      const rows = await pool.querySync([relayUrl], { ids: [eventId] });
      if (rows.length !== 1) throw new Error(`Expected one immutable ratchet event, got ${rows.length}.`);
      const opened = openAuthorizedRatchetDm({ wrap: rows[0],
        recipientDeviceSecret: receiver.primaryDevice.deviceSecret,
        senderCheckpoint, recipientCheckpoint,
        recipientDeviceId: receiver.primaryDevice.deviceId,
        recipientRequesterDeviceId: receiver.primaryDevice.deviceId,
        now: Math.floor(Date.now() / 1000) });
      if (!opened) throw new Error('The recipient did not validate both authority proofs in the delivered event.');
      return { eventId: rows[0].id, operationId: opened.operationId,
        ratchetCiphertext: opened.ratchetCiphertext,
        recipientDeviceId: opened.recipientDeviceId,
        senderAccountPubkey: opened.senderAccountPubkey };
    } finally { pool.close([relayUrl]); }
  }, { eventId: ratchetCommit.event.id, senderCheckpoint: sendAuthorization.sender.checkpoint, relayUrl: relay.url });
  const retryRatchet = await a.evaluate(async ({ event, freshUntil, relayUrl }) => {
    const { publishRatchetEventAtProofBoundary } = await import('/src/lib/ratchetProofAwareTransport.js');
    return publishRatchetEventAtProofBoundary({ url: relayUrl, event, freshUntil,
      assertCurrent: () => window.__identity.securityFence.assertCurrent(), timeoutMs: 2500 });
  }, { ...ratchetCommit, relayUrl: relay.url });
  const ratchetFrames = await a.evaluate((eventId) => window.__webSocketSent
    .filter((item) => item.frame?.[0] === 'EVENT' && item.frame[1]?.id === eventId)
    .map((item) => ({ at: item.at, readyState: item.readyState, frame: item.frame })), ratchetCommit.event.id);
  if (retryRatchet.eventId !== ratchetCommit.event.id || ratchetFrames.length !== 2
    || JSON.stringify(ratchetFrames[0].frame) !== JSON.stringify(ratchetFrames[1].frame)) {
    throw new Error('Uncertain acknowledgement retry did not reuse the exact immutable ratchet event.');
  }
  if (openedRatchet.operationId !== ratchetCommit.operationId
    || openedRatchet.ratchetCiphertext !== 'fixture-ciphertext-from-no-live-ratchet') {
    throw new Error('Recipient did not open the same authenticated fixture operation.');
  }
  const frameSummary = relay.frames.map(({ direction, atMs, frame }) => {
    if (direction === 'client' && frame?.[0] === 'REQ') {
      return { direction, atMs, type: 'REQ', subscriptionId: frame[1], filters: frame.slice(2) };
    }
    if (direction === 'client' && frame?.[0] === 'EVENT') {
      const event = frame[1];
      return { direction, atMs, type: 'EVENT', id: event.id, kind: event.kind,
        created_at: event.created_at, outerPubkey: event.pubkey, tags: event.tags,
        contentUtf8Bytes: Buffer.byteLength(event.content || '', 'utf8'),
        signaturePresent: !!event.sig, event };
    }
    if (direction === 'relay' && frame?.[0] === 'OK') {
      return { direction, atMs, type: 'OK', eventId: frame[1], accepted: frame[2], message: frame[3] };
    }
    if (direction === 'relay' && frame?.[0] === 'TEST_DROP_ACK') {
      return { direction, atMs, type: 'TEST_DROP_ACK', eventId: frame[1] };
    }
    return null;
  }).filter(Boolean);
  const evidence = {
    result: 'passed',
    captureSchema: 'cipher-local-nip01-relay-capture-v1',
    protocolSpecRevision: 'cipher-dm-v1-review-candidate-r1',
    generatedAt: new Date().toISOString(),
    transport: 'disposable NIP-01-compatible WebSocket relay bound to loopback; no production account or public relay',
    relayUrl: relay.url,
    relayConnections: relay.connections,
    clients: { senderAccount: alice, recipientAccount: bob },
    appPath: 'useNIP44DM.sendDM -> write-ahead outbox -> nostr-tools SimplePool -> browser WebSocket -> local NIP-01 relay -> useNIP44DM subscription/decrypt/save',
    eventId: send.event.id,
    handoffAtPerformanceMs: actualSocketEvent.at,
    handoffAtWallClockMs: actualSocketEvent.atWallClockMs,
    ratchetPrototype: { eventId: ratchetCommit.event.id, operationId: ratchetCommit.operationId,
      uncertainty: uncertainAttempt.error, exactEventRetries: ratchetFrames.length,
      exactRetryFramesEqual: JSON.stringify(ratchetFrames[0]?.frame) === JSON.stringify(ratchetFrames[1]?.frame),
      recipient: openedRatchet, limitation: 'fixture ciphertext and ratchet state; no live ratchet library or app caller' },
    relayVisibleFrames: frameSummary,
    limitations: ['Synthetic Nostr accounts and local fixture relay only.',
      'The ordinary app path remains NIP-44/NIP-59; this is not ratchet integration.',
      'The R5 event contains fixture ciphertext/state and synthetic proof construction.',
      'No public relay interoperability, IP anonymity, or production security claim follows.'],
  };
  const encodedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
  if (process.env.CIPHER_DM_CAPTURE_FILE) {
    const capturePath = path.resolve(root, process.env.CIPHER_DM_CAPTURE_FILE);
    await mkdir(path.dirname(capturePath), { recursive: true });
    await writeFile(capturePath, encodedEvidence, { mode: 0o600 });
  }
  console.log(encodedEvidence);
  await Promise.all([a, b].map((page) => page.evaluate(() => window.__stopDmSubscription?.())));
} finally {
  await contextA?.close();
  await contextB?.close();
  await browser?.close();
  await vite.close();
  await relay.close();
}

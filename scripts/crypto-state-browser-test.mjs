import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { buildDeviceRegistryEvent } from '../src/lib/deviceEnrollment.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mlsWasmDir = path.join(root, 'crypto/mls-eval/target/browser-bindings');
const vite = await createViteServer({
  configFile: path.join(root, 'vite.config.js'),
  server: { host: '127.0.0.1', port: 8094, strictPort: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
vite.middlewares.use((request, response, next) => {
  if (request.url === '/mls/cipher_mls_eval.js' || request.url === '/mls/cipher_mls_eval_bg.wasm') {
    const file = request.url.endsWith('.wasm') ? 'cipher_mls_eval_bg.wasm' : 'cipher_mls_eval.js';
    response.setHeader('content-type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8');
    readFile(path.join(mlsWasmDir, file)).then((bytes) => response.end(bytes)).catch((error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
    return;
  }
  if (request.url !== '/__crypto_state_browser_test') return next();
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><html><head><title>Crypto state test</title></head><body>ready</body></html>');
});
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const url = 'http://127.0.0.1:8094/__crypto_state_browser_test';
  const first = await context.newPage();
  await first.goto(url, { waitUntil: 'domcontentloaded' });
  const accountSecret = generateSecretKey();
  const owner = getPublicKey(accountSecret);
const peerAccountSecret = generateSecretKey();
const peerOwner = getPublicKey(peerAccountSecret);
if (peerOwner === owner) throw new Error('Peer device-registry flow requires independent accounts.');
  const registryNow = Math.floor(Date.now() / 1000);
  const baseDevice = { deviceId: 'a'.repeat(32), pubkey: owner, status: 'active', enrolledAt: registryNow - 10 };
  const registryOne = buildDeviceRegistryEvent({
    accountSecret, generation: 1, devices: [baseDevice],
  }, registryNow - 2);
  const registryTwoA = buildDeviceRegistryEvent({
    accountSecret, generation: 2, devices: [baseDevice, { deviceId: 'b'.repeat(32), pubkey: '1'.repeat(64), status: 'active', enrolledAt: registryNow }],
  }, registryNow - 1);
  const registryTwoB = buildDeviceRegistryEvent({
    accountSecret, generation: 2, devices: [baseDevice, { deviceId: 'c'.repeat(32), pubkey: '2'.repeat(64), status: 'active', enrolledAt: registryNow }],
  }, registryNow - 1);
  const setup = async (page, account = owner) => page.evaluate(async (pk) => {
    const [{ openDBFor, db }, { setAtRestKeyProvider }] = await Promise.all([
      import('/src/db.js'),
      import('/src/lib/messageAtRest.js'),
    ]);
    const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 71);
    setAtRestKeyProvider(() => secret);
    openDBFor(pk);
    await db.open();
    return { ready: true };
  }, account);
  await setup(first);
  await first.evaluate(async (event) => {
    const { acceptDeviceRegistry } = await import('/src/lib/deviceRegistryStore.js');
    await acceptDeviceRegistry(localStorage.getItem('cipher_db_owner'), event);
  }, registryOne);
  const mlsSnapshot = await first.evaluate(async () => {
    const mls = await import('/mls/cipher_mls_eval.js');
    await mls.default();
    const snapshot = mls.create_persisted_group_snapshot();
    if (!mls.persisted_group_snapshot_restores(snapshot)) throw new Error('OpenMLS could not restore its own serialized provider state.');
    const { commitMlsOutbound } = await import('/src/lib/mlsStateTransactions.js');
    await commitMlsOutbound({
      owner: localStorage.getItem('cipher_db_owner'),
      groupId: 'browser-openmls-snapshot',
      expectedVersion: null,
      state: { providerSnapshot: snapshot },
      event: { id: 'browser-openmls-snapshot', sig: 'sig-openmls', kind: 9, created_at: 4 },
      now: 4,
    });
    return snapshot;
  });
  await first.evaluate(async () => {
    const { commitMlsOutbound } = await import('/src/lib/mlsStateTransactions.js');
    await commitMlsOutbound({
      owner: localStorage.getItem('cipher_db_owner'),
      groupId: 'browser-group',
      expectedVersion: null,
      state: { snapshot: 'epoch-0' },
      event: { id: 'browser-seed', sig: 'sig-seed', kind: 9, created_at: 1 },
      now: 1,
    });
  });
  await first.evaluate(async () => {
    const { commitRatchetOutbound } = await import('/src/lib/dmRatchetTransactions.js');
    await commitRatchetOutbound({
      owner: localStorage.getItem('cipher_db_owner'),
      sessionId: 'browser-session',
      peerPubkey: 'peer',
      peerDeviceId: 'peer-device',
      expectedVersion: null,
      state: { pickle: 'ratchet-epoch-0' },
      event: { id: 'browser-ratchet-seed', sig: 'sig-ratchet-seed', kind: 1059, created_at: 2 },
      now: 2,
    });
  });
  const second = await context.newPage();
  await second.goto(url, { waitUntil: 'domcontentloaded' });
  await setup(second);

  // The DM effect journal is shared by real same-account Chromium tabs. Two
  // separately signed candidates race for one countersign idempotency key;
  // IndexedDB must choose one immutable event and atomically pair it with the
  // write-ahead outbox row. Completing through a second tab simulates delivery
  // followed by a crash before the first tab updated local state.
  const effectCandidates = [
    finalizeEvent({ kind: 1059, created_at: registryNow, tags: [], content: 'candidate-a' }, accountSecret),
    finalizeEvent({ kind: 1059, created_at: registryNow, tags: [], content: 'candidate-b' }, accountSecret),
  ];
  const effectRace = await Promise.all(effectCandidates.map((event, index) => [first, second][index].evaluate(async ({ candidate, key }) => {
    const { reserveMessageEffect } = await import('/src/lib/idempotentMessageEffect.js');
    return reserveMessageEffect({
      owner: localStorage.getItem('cipher_db_owner'),
      idempotencyKey: key,
      intent: key,
      event: candidate,
      relays: ['wss://relay-one.invalid'],
    });
  }, { candidate: event, key: 'browser-receipt|order-a|receipt-a' })));
  if (effectRace[0].eventId !== effectRace[1].eventId
    || effectRace.filter((row) => row.created).length !== 1
    || effectRace.some((row) => row.event?.id !== effectRace[0].eventId)) {
    throw new Error(`Cross-tab DM effect reservation diverged: ${JSON.stringify(effectRace.map(({ eventId, created, event }) => ({ eventId, created, eventIdFromEvent: event?.id })))}`);
  }
  await second.evaluate(async (eventId) => {
    const { completeMessageEffect } = await import('/src/lib/idempotentMessageEffect.js');
    await completeMessageEffect({ owner: localStorage.getItem('cipher_db_owner'), eventId });
  }, effectRace[0].eventId);
  const recoveredEffect = await first.evaluate(async ({ event, key }) => {
    const { reserveMessageEffect } = await import('/src/lib/idempotentMessageEffect.js');
    return reserveMessageEffect({ owner: localStorage.getItem('cipher_db_owner'), idempotencyKey: key, intent: key, event });
  }, { event: effectCandidates[1], key: 'browser-receipt|order-a|receipt-a' });
  if (recoveredEffect.status !== 'sent' || recoveredEffect.event !== null) {
    throw new Error('A second tab retried an already completed DM application effect.');
  }
  const groupActorSecret = generateSecretKey();
  const groupCandidates = [
    finalizeEvent({ kind: 9, created_at: registryNow, tags: [['h', 'browser-group-id'], ['client', 'browser-group-client']], content: 'group ciphertext A' }, groupActorSecret),
    finalizeEvent({ kind: 9, created_at: registryNow, tags: [['h', 'browser-group-id'], ['client', 'browser-group-client']], content: 'group ciphertext B' }, groupActorSecret),
  ];
  const groupEffectRace = await Promise.all(groupCandidates.map((event, index) => [first, second][index].evaluate(async ({ candidate, key }) => {
    const { reserveMessageEffect } = await import('/src/lib/idempotentMessageEffect.js');
    return reserveMessageEffect({
      owner: localStorage.getItem('cipher_db_owner'),
      idempotencyKey: key,
      intent: 'same encrypted group client message',
      event: candidate,
      relays: ['wss://group-relay.invalid'],
    });
  }, { candidate: event, key: 'group-message-v1|browser-group-id|browser-group-client' })));
  if (groupEffectRace[0].eventId !== groupEffectRace[1].eventId
    || groupEffectRace.filter((row) => row.created).length !== 1
    || groupEffectRace.some((row) => row.event?.pubkey !== getPublicKey(groupActorSecret))) {
    throw new Error(`Cross-tab group message reservation lost its actor or event identity: ${JSON.stringify(groupEffectRace.map(({ eventId, created }) => ({ eventId, created })))}`);
  }
  await second.evaluate(async (eventId) => {
    const { completeMessageEffect } = await import('/src/lib/idempotentMessageEffect.js');
    await completeMessageEffect({ owner: localStorage.getItem('cipher_db_owner'), eventId });
  }, groupEffectRace[0].eventId);
  // Incoming DM and group deliveries share the same durable message-id claim.
  // Race two real tabs against one event and make sure only one can own the
  // side-effect gate after IndexedDB commits the encrypted message row.
  const incomingMessageRace = await Promise.all([first, second].map((page) => page.evaluate(async () => {
    const { saveMessageOnce } = await import('/src/db.js');
    return saveMessageOnce('browser-peer', {
      id: 'browser-incoming-once', timestamp: 11,
      pubkey: 'browser-peer', data: { type: 'text', message: 'one durable delivery' },
    });
  })));
  if (incomingMessageRace.filter((row) => row.status === 'inserted').length !== 1
    || incomingMessageRace.filter((row) => row.status === 'exists').length !== 1) {
    throw new Error(`Cross-tab incoming event claim was not exclusive: ${JSON.stringify(incomingMessageRace)}`);
  }
  const incomingMessageCount = await first.evaluate(async () =>
    (await (await import('/src/db.js')).db.messages.where('id').equals('browser-incoming-once').count()));
  if (incomingMessageCount !== 1) throw new Error(`Incoming event stored ${incomingMessageCount} times.`);
  const paymentLockRace = await Promise.all([first, second].map((page, index) => page.evaluate(async (tab) => {
    const { withPaymentLedgerLock } = await import('/src/lib/paymentLedgerLock.js');
    return withPaymentLedgerLock(async () => {
      if (localStorage.getItem('browser-payment-lock-active') === '1') return { overlap: true, tab };
      localStorage.setItem('browser-payment-lock-active', '1');
      await new Promise((resolve) => setTimeout(resolve, 80));
      localStorage.setItem('browser-payment-lock-active', '0');
      return { overlap: false, tab };
    }, { scope: localStorage.getItem('cipher_db_owner') });
  }, index)));
  if (paymentLockRace.some((row) => row.overlap)) {
    throw new Error(`Concurrent browser payment confirmations escaped the cross-tab lock: ${JSON.stringify(paymentLockRace)}`);
  }

  // Exercise registry transport with two independent browser accounts. The
  // relay-visible object is the actual kind-1059 event produced in Chromium;
  // the receiving account verifies it and persists the peer checkpoint in
  // native browser IndexedDB under its own at-rest key.
  const peerContext = await browser.newContext();
  const peerPage = await peerContext.newPage();
  await peerPage.goto(url, { waitUntil: 'domcontentloaded' });
  await setup(peerPage, peerOwner);
  const peerDeviceSecret = generateSecretKey();
  const peerDevicePubkey = getPublicKey(peerDeviceSecret);
  const peerRegistryOne = buildDeviceRegistryEvent({
    accountSecret,
    generation: 1,
    devices: [{ deviceId: 'e'.repeat(32), pubkey: peerDevicePubkey, status: 'active', enrolledAt: registryNow - 1 }],
  }, registryNow - 1);
  const privateRegistryWrap = await first.evaluate(async ({ registryEvent, senderSecret, recipientPubkey }) => {
    const { buildPrivateDeviceRegistryWrap } = await import('/src/lib/deviceRegistryWire.js');
    return buildPrivateDeviceRegistryWrap({
      registryEvent,
      senderSecret: Uint8Array.from(senderSecret),
      recipientPubkey,
      now: Math.floor(Date.now() / 1000),
    });
  }, { registryEvent: peerRegistryOne, senderSecret: Array.from(accountSecret), recipientPubkey: peerOwner });
  const publicWrapJson = JSON.stringify(privateRegistryWrap);
  if (privateRegistryWrap.kind !== 1059 || !publicWrapJson.includes(peerOwner)
    || publicWrapJson.includes(owner) || publicWrapJson.includes(peerDevicePubkey)
    || publicWrapJson.includes(peerRegistryOne.id)) {
    throw new Error('The browser relay-visible registry wrap exposed sender/device registry identifiers.');
  }
  const acceptedPeerRegistry = await peerPage.evaluate(async ({ wrap, recipientSecret }) => {
    const { openPrivateDeviceRegistryWrap } = await import('/src/lib/deviceRegistryWire.js');
    const { acceptPeerDeviceRegistry, loadPeerDeviceRegistry } = await import('/src/lib/deviceRegistryStore.js');
    const ownerId = localStorage.getItem('cipher_db_owner');
    const opened = openPrivateDeviceRegistryWrap({ wrap, recipientSecret: Uint8Array.from(recipientSecret) });
    if (!opened) throw new Error('The independent recipient browser could not open the registry DM.');
    await acceptPeerDeviceRegistry(ownerId, opened.event);
    const raw = await (await import('/src/db.js')).db.peerDeviceAuth.get(opened.senderPubkey);
    const restored = await loadPeerDeviceRegistry(ownerId, opened.senderPubkey);
    return {
      senderPubkey: opened.senderPubkey,
      generation: restored.generation,
      registryEventId: restored.event.id,
      storedContentVisible: JSON.stringify(raw).includes(restored.event.content),
    };
  }, { wrap: privateRegistryWrap, recipientSecret: Array.from(peerAccountSecret) });
  if (acceptedPeerRegistry.senderPubkey !== owner || acceptedPeerRegistry.generation !== 1
    || acceptedPeerRegistry.registryEventId !== peerRegistryOne.id || acceptedPeerRegistry.storedContentVisible) {
    throw new Error(`Private peer registry did not verify and persist safely: ${JSON.stringify(acceptedPeerRegistry)}`);
  }
  await peerContext.close();

  const registryRace = await Promise.all([registryTwoA, registryTwoB].map((event, index) => [first, second][index].evaluate(async (candidate) => {
    const { acceptDeviceRegistry } = await import('/src/lib/deviceRegistryStore.js');
    try {
      await acceptDeviceRegistry(localStorage.getItem('cipher_db_owner'), candidate);
      return { accepted: true, eventId: candidate.id };
    } catch (error) {
      return { accepted: false, error: error.name };
    }
  }, event)));
  if (registryRace.filter((item) => item.accepted).length !== 1
    || registryRace.filter((item) => item.error === 'DeviceRegistryConflict').length !== 1) {
    throw new Error(`Cross-tab device registry equivocation was not rejected: ${JSON.stringify(registryRace)}`);
  }
  const currentRegistryEvent = [registryTwoA, registryTwoB].find((event) => registryRace.some((row) => row.accepted && row.eventId === event.id));
  const deviceSecret = generateSecretKey();
  const deviceId = 'd'.repeat(32);
  const deviceRow = { deviceId, pubkey: getPublicKey(deviceSecret), status: 'active', enrolledAt: registryNow + 1 };
  const currentRegistry = JSON.parse(currentRegistryEvent.content);
  const registryThree = buildDeviceRegistryEvent({
    accountSecret,
    generation: 3,
    devices: [...currentRegistry.devices, deviceRow],
  }, registryNow + 1);
  const registryFour = buildDeviceRegistryEvent({
    accountSecret,
    generation: 4,
    devices: [...currentRegistry.devices, { ...deviceRow, status: 'revoked', revokedAt: registryNow + 2 }],
  }, registryNow + 2);
  await first.evaluate(async ({ event, deviceId: id, deviceSecret: secret }) => {
    const { commitEnrolledDevice } = await import('/src/lib/deviceRegistryStore.js');
    await commitEnrolledDevice({
      owner: localStorage.getItem('cipher_db_owner'),
      event,
      deviceId: id,
      deviceSecret: Uint8Array.from(secret),
    });
    const raw = await (await import('/src/db.js')).db.ratchetDevices.get(id);
    if (JSON.stringify(raw).includes(Array.from(secret, (byte) => byte.toString(16).padStart(2, '0')).join(''))) {
      throw new Error('The device signing secret reached IndexedDB in the clear.');
    }
  }, { event: registryThree, deviceId, deviceSecret: Array.from(deviceSecret) });

  const race = await Promise.all([first, second].map((page, index) => page.evaluate(async (number) => {
    const { commitMlsOutbound } = await import('/src/lib/mlsStateTransactions.js');
    const ownerId = localStorage.getItem('cipher_db_owner');
    try {
      const version = await commitMlsOutbound({
        owner: ownerId,
        groupId: 'browser-group',
        expectedVersion: 0,
        state: { snapshot: `concurrent-${number}` },
        event: { id: `browser-race-${number}`, sig: 'sig-race', kind: 9, created_at: number + 2 },
        now: number + 2,
      });
      return { committed: true, version };
    } catch (error) {
      return { committed: false, error: error.name };
    }
  }, index + 1)));
  if (race.filter((item) => item.committed).length !== 1
    || race.filter((item) => item.error === 'MlsStateConflict').length !== 1) {
    throw new Error(`Cross-tab MLS CAS race was not exclusive: ${JSON.stringify(race)}`);
  }
  const ratchetRace = await Promise.all([first, second].map((page, index) => page.evaluate(async (number) => {
    const { commitRatchetOutbound } = await import('/src/lib/dmRatchetTransactions.js');
    try {
      const version = await commitRatchetOutbound({
        owner: localStorage.getItem('cipher_db_owner'),
        sessionId: 'browser-session',
        peerPubkey: 'peer',
        peerDeviceId: 'peer-device',
        expectedVersion: 0,
        state: { pickle: `ratchet-concurrent-${number}` },
        event: { id: `browser-ratchet-race-${number}`, sig: 'sig-ratchet', kind: 1059, created_at: number + 3 },
        now: number + 3,
      });
      return { committed: true, version };
    } catch (error) {
      return { committed: false, error: error.name };
    }
  }, index + 1)));
  if (ratchetRace.filter((item) => item.committed).length !== 1
    || ratchetRace.filter((item) => item.error === 'RatchetStateConflict').length !== 1) {
    throw new Error(`Cross-tab ratchet CAS race was not exclusive: ${JSON.stringify(ratchetRace)}`);
  }

  await first.evaluate(async () => {
    const { commitMlsInbound } = await import('/src/lib/mlsStateTransactions.js');
    const state = await (await import('/src/lib/mlsStateTransactions.js')).loadMlsState(
      localStorage.getItem('cipher_db_owner'), 'browser-group',
    );
    await commitMlsInbound({
      owner: localStorage.getItem('cipher_db_owner'),
      groupId: 'browser-group',
      expectedVersion: state.version,
      state: { snapshot: 'remote-commit-applied' },
      eventId: 'browser-inbound-1',
      journal: { message: 'resume after reload' },
      now: 10,
    });
  });
  await first.close();
  const restored = await context.newPage();
  await restored.goto(url, { waitUntil: 'domcontentloaded' });
  await setup(restored);
  const recovery = await restored.evaluate(async () => {
    const { loadMlsState, loadPendingMlsInbox } = await import('/src/lib/mlsStateTransactions.js');
    const { loadRatchetState } = await import('/src/lib/dmRatchetTransactions.js');
    const ownerId = localStorage.getItem('cipher_db_owner');
    return {
      state: await loadMlsState(ownerId, 'browser-group'),
      openMlsSnapshot: await loadMlsState(ownerId, 'browser-openmls-snapshot'),
      registry: await (await import('/src/lib/deviceRegistryStore.js')).loadDeviceRegistry(ownerId),
      deviceCredential: Array.from(await (await import('/src/lib/deviceRegistryStore.js')).loadDeviceCredential(ownerId, 'd'.repeat(32))),
      ratchet: await loadRatchetState({ owner: ownerId, collection: 'sessions', id: 'browser-session', table: (await import('/src/db.js')).db.ratchetSessions }),
      inbox: await loadPendingMlsInbox(ownerId),
      outboxIds: (await (await import('/src/db.js')).db.outbox.toArray()).map((row) => row.id).sort(),
    };
  });
  const mlsRestored = await restored.evaluate(async (snapshot) => {
    const mls = await import('/mls/cipher_mls_eval.js');
    await mls.default();
    return mls.persisted_group_snapshot_restores(snapshot);
  }, recovery.openMlsSnapshot.value.providerSnapshot);
  if (recovery.deviceCredential.join(',') !== Array.from(deviceSecret).join(',')) {
    throw new Error('The enrolled device signing secret did not restore from sealed browser storage.');
  }
  const revokedDevice = await restored.evaluate(async ({ event, id }) => {
    const registry = await import('/src/lib/deviceRegistryStore.js');
    await registry.acceptDeviceRegistry(localStorage.getItem('cipher_db_owner'), event);
    const remaining = await (await import('/src/db.js')).db.ratchetDevices.get(id);
    let refused = false;
    try { await registry.loadDeviceCredential(localStorage.getItem('cipher_db_owner'), id); }
    catch { refused = true; }
    return { secretRemoved: !remaining, credentialRefused: refused };
  }, { event: registryFour, id: deviceId });
  if (!mlsRestored || recovery.openMlsSnapshot.value.providerSnapshot !== mlsSnapshot
    || !revokedDevice.secretRemoved || !revokedDevice.credentialRefused
    || recovery.registry.generation !== 3
    || recovery.registry.event.id !== registryThree.id
    || recovery.state.value.snapshot !== 'remote-commit-applied'
    || !recovery.ratchet.value.pickle.startsWith('ratchet-concurrent-')
    || recovery.inbox[0]?.journal.message !== 'resume after reload'
    || recovery.outboxIds.length !== 5 || !recovery.outboxIds.includes('browser-seed')
    || !recovery.outboxIds.includes('browser-ratchet-seed')) {
    throw new Error(`Browser reload recovery did not restore the durable state: ${JSON.stringify(recovery)}`);
  }
  console.log(`Chromium IndexedDB crypto-state integration passed: ${JSON.stringify({
    nativeIndexedDB: true,
    concurrentTabs: race,
    concurrentRatchetTabs: ratchetRace,
    concurrentMessageEffectTabs: effectRace.map(({ eventId, created }) => ({ eventId, created })),
    concurrentGroupMessageTabs: groupEffectRace.map(({ eventId, created }) => ({ eventId, created })),
    dmEffectCrashRecovery: recoveredEffect.status,
    incomingMessageTabs: incomingMessageRace.map(({ status }) => status),
    incomingMessageRows: incomingMessageCount,
    paymentLedgerLockAcrossTabs: paymentLockRace,
    concurrentDeviceRegistryTabs: registryRace,
    privatePeerRegistryAcrossIndependentAccounts: acceptedPeerRegistry,
    sealedDeviceCredentialRestoreAndRevocation: revokedDevice,
    outboxRetriesRemainDurable: true,
    reloadRestoredMlsSnapshot: true,
    restoredActualOpenMlsProviderState: true,
    pendingInboundJournalRestored: true,
  })}`);
  await context.close();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await vite.close();
}

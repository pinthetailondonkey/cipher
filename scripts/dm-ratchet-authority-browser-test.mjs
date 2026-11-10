import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  buildDeviceEnrollmentProofV2, buildDeviceFreshnessResponseV2, createDeviceAuthoritySetup,
  createDeviceEnrollmentChallengeV2, createDeviceFreshnessChallengeV2, createIndependentDeviceCredential,
  enrollDeviceV2,
} from '../src/lib/deviceAuthority.js';
import { authorizeRatchetSend, buildAuthorizedRatchetDm, createRatchetOperationId } from '../src/lib/dmRatchetAuthority.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createViteServer({ configFile: path.join(root, 'vite.config.js'),
  server: { host: '127.0.0.1', port: 8097, strictPort: true }, appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: ['dexie'] } });
vite.middlewares.use((request, response, next) => {
  if (request.url !== '/__dm_ratchet_authority_test') return next();
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><html><body>isolated ratchet authority test</body></html>');
});

const now = Math.floor(Date.now() / 1000);
let nonceByte = 1;
const randomBytes = (target) => target.fill(nonceByte++);
function account() {
  const setup = createDeviceAuthoritySetup({ accountPubkey: getPublicKey(generateSecretKey()), now, randomBytes });
  const device = createIndependentDeviceCredential(randomBytes);
  const challengeEvent = createDeviceEnrollmentChallengeV2({ policyEvent: setup.policyEvent,
    registryEvent: setup.registryEvent, expectedRegistryId: setup.registryEvent.id,
    authoritySecret: setup.authoritySecret, deviceId: device.deviceId,
    devicePubkey: device.devicePubkey, now: now + 1, randomBytes });
  const proofEvent = buildDeviceEnrollmentProofV2({ challengeEvent, policyEvent: setup.policyEvent,
    registryEvent: setup.registryEvent, expectedRegistryId: setup.registryEvent.id,
    deviceSecret: device.deviceSecret, now: now + 2 });
  const registryEvent = enrollDeviceV2({ policyEvent: setup.policyEvent,
    registryEvent: setup.registryEvent, expectedRegistryId: setup.registryEvent.id,
    challengeEvent, proofEvent, authoritySecret: setup.authoritySecret, now: now + 3 });
  const body = JSON.parse(setup.policyEvent.content);
  return { ...setup, device, registryEvent, checkpoint: { accountPubkey: body.accountPubkey,
    recoveryPubkey: body.recoveryPubkey, policyEvent: setup.policyEvent, policyId: setup.policyEvent.id,
    registryEvent, registryId: registryEvent.id, registryHistory: [setup.registryEvent, registryEvent] } };
}
function proof(person, operationId, target = person.primaryDevice, at = now + 4) {
  const challengeEvent = createDeviceFreshnessChallengeV2({
    policyEvent: person.policyEvent, registryEvent: person.registryEvent,
    expectedRegistryId: person.registryEvent.id, requesterDeviceSecret: person.primaryDevice.deviceSecret,
    requesterDeviceId: person.primaryDevice.deviceId, targetDeviceId: target.deviceId,
    purpose: 'send-dm', operationId, now: at, randomBytes,
  });
  const responseEvent = buildDeviceFreshnessResponseV2({ policyEvent: person.policyEvent,
    registryEvent: person.registryEvent, expectedRegistryId: person.registryEvent.id,
    challengeEvent, authoritySecret: person.authoritySecret, now: at + 1 });
  return { checkpoint: person.checkpoint, deviceId: target.deviceId,
    requesterDeviceId: person.primaryDevice.deviceId, challengeEvent, responseEvent };
}

let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  const alice = account();
  const bob = account();
  const operationId = createRatchetOperationId();
  const senderProof = proof(alice, operationId);
  const recipientProof = proof(bob, operationId, bob.device);
  const vaultKey = Array.from({ length: 32 }, (_, index) => index + 1);
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const aliceTabs = await Promise.all([aliceContext.newPage(), aliceContext.newPage()]);
  const bobTabs = await Promise.all([bobContext.newPage(), bobContext.newPage()]);
  await Promise.all([...aliceTabs, ...bobTabs].map((page) => page.goto('http://127.0.0.1:8097/__dm_ratchet_authority_test')));

  const aliceInput = { checkpoint: alice.checkpoint, senderProof, recipientProof,
    accountPubkey: alice.checkpoint.accountPubkey, peerPubkey: bob.checkpoint.accountPubkey,
    peerDeviceId: bob.device.deviceId, senderDeviceSecret: Array.from(alice.primaryDevice.deviceSecret),
    operationId, vaultKey, nowMs: (now + 6) * 1000 };
  const commitInTab = (page) => page.evaluate(async (input) => {
    const { openDBFor, db } = await import('/src/db.js');
    const { setAtRestKeyProvider } = await import('/src/lib/messageAtRest.js');
    const { createSecurityContextFence, establishSecurityContext, SECURITY_CONTEXT_KEY } = await import('/src/lib/securityContextFence.js');
    const { commitRatchetOutboundV2 } = await import('/src/lib/dmRatchetTransactions.js');
    const { shouldFlushOutboxRow } = await import('/src/lib/outbox.js');
    setAtRestKeyProvider(() => Uint8Array.from(input.vaultKey));
    const context = establishSecurityContext({ owner: input.accountPubkey });
    const channel = new BroadcastChannel(`${SECURITY_CONTEXT_KEY}:invalidate`);
    const securityFence = createSecurityContextFence({ context, channel });
    openDBFor(input.accountPubkey);
    await db.open();
    const result = await commitRatchetOutboundV2({ owner: input.accountPubkey,
      sessionId: 'browser-two-account-session', peerPubkey: input.peerPubkey,
      peerDeviceId: input.peerDeviceId, expectedVersion: null, state: { sendChain: 'next' },
      ratchetCiphertext: 'browser-ratchet-ciphertext',
      applicationPayload: { kind: 'order-receipt', id: 'browser-effect-once' },
      senderDeviceSecret: Uint8Array.from(input.senderDeviceSecret),
      authorization: { operationId: input.operationId, sender: input.senderProof, recipient: input.recipientProof },
      securityFence,
      now: input.nowMs });
    const rows = await db.outbox.toArray();
    const ratchetRow = rows.find((row) => row.ratchetDelivery?.operationId === input.operationId);
    return { result, ratchetRow, flushBefore: shouldFlushOutboxRow(ratchetRow, input.nowMs),
      flushAfterExpiry: shouldFlushOutboxRow(ratchetRow, input.nowMs + 31_000, true) };
  }, aliceInput);
  const races = await Promise.all(aliceTabs.map(commitInTab));
  if (races.some((item) => item.result.eventId !== races[0].result.eventId)
    || races.filter((item) => item.result.alreadyCommitted).length !== 1
    || races.some((item) => item.ratchetRow?.ratchetDelivery?.operationId !== operationId)) {
    throw new Error(`Concurrent sender tabs did not converge on one durable event: ${JSON.stringify(races.map((row) => row.result))}`);
  }
  if (!races[0].flushBefore || races[0].flushAfterExpiry) throw new Error('The browser outbox bypassed the single-operation authorization expiry.');
  const event = races[0].result.event || await aliceTabs[1].evaluate(async (id) => {
    const { db } = await import('/src/db.js');
    return (await db.outbox.get(id))?.event;
  }, races[0].result.eventId);
  if (!event || event.kind !== 1059 || JSON.stringify(event).includes(alice.checkpoint.accountPubkey)
    || JSON.stringify(event).includes(bob.checkpoint.accountPubkey)) {
    throw new Error('The captured relay EVENT exposes an account identity or is not a NIP-59 wrap.');
  }

  const bobInput = { owner: bob.checkpoint.accountPubkey, deviceId: bob.device.deviceId,
    recipientDeviceSecret: Array.from(bob.device.deviceSecret), senderCheckpoint: alice.checkpoint,
    recipientCheckpoint: bob.checkpoint, recipientRequesterDeviceId: bob.primaryDevice.deviceId,
    wrap: event, nowMs: (now + 7) * 1000, vaultKey };
  const receiveInTab = (page) => page.evaluate(async (input) => {
    const { openDBFor, db } = await import('/src/db.js');
    const { setAtRestKeyProvider } = await import('/src/lib/messageAtRest.js');
    const { createSecurityContextFence, establishSecurityContext, SECURITY_CONTEXT_KEY } = await import('/src/lib/securityContextFence.js');
    const { commitRatchetInboundV2, loadRatchetState } = await import('/src/lib/dmRatchetTransactions.js');
    setAtRestKeyProvider(() => Uint8Array.from(input.vaultKey));
    const context = establishSecurityContext({ owner: input.owner });
    const channel = new BroadcastChannel(`${SECURITY_CONTEXT_KEY}:invalidate`);
    const securityFence = createSecurityContextFence({ context, channel });
    openDBFor(input.owner);
    await db.open();
    let effects = 0;
    const options = { owner: input.owner, deviceId: input.deviceId,
      recipientDeviceSecret: Uint8Array.from(input.recipientDeviceSecret),
      senderCheckpoint: input.senderCheckpoint, recipientCheckpoint: input.recipientCheckpoint,
      recipientRequesterDeviceId: input.recipientRequesterDeviceId, wrap: input.wrap,
      expectedVersion: null, securityFence, now: input.nowMs,
      processRatchetMessage: async ({ ratchetCiphertext, applicationPayload }) => {
        effects += 1;
        if (ratchetCiphertext !== 'browser-ratchet-ciphertext') throw new Error('wrong ciphertext');
        return { sessionId: 'browser-two-account-session', sessionState: { receiveChain: 'next' },
          chatId: 'alice-chat', journal: { payload: applicationPayload } };
      } };
    const first = await commitRatchetInboundV2(options);
    const state = await loadRatchetState({ owner: input.owner, collection: 'sessions',
      id: 'browser-two-account-session', table: db.ratchetSessions });
    return { first, effects, state };
  }, bobInput);
  const receives = await Promise.all(bobTabs.map(receiveInTab));
  if (receives.reduce((sum, result) => sum + result.effects, 0) !== 1
    || receives.filter((result) => result.first.busy).length !== 1
    || receives.filter((result) => !result.first.busy && !result.first.duplicate).length !== 1
    || receives.find((result) => !result.first.busy)?.first.applicationPayload.id !== 'browser-effect-once') {
    throw new Error(`Concurrent receiver tabs did not claim one operation: ${JSON.stringify(receives)}`);
  }
  const busyTab = bobTabs[receives.findIndex((result) => result.first.busy)];
  const retried = await receiveInTab(busyTab);
  if (!retried.first.duplicate || retried.effects !== 0) {
    throw new Error(`The losing receiver tab did not recover as an idempotent duplicate: ${JSON.stringify(retried)}`);
  }

  const fencedOperationId = createRatchetOperationId();
  const fencedAuthorization = authorizeRatchetSend({ operationId: fencedOperationId,
    sender: proof(alice, fencedOperationId), recipient: proof(bob, fencedOperationId, bob.device), now: now + 7 });
  const fencedMessage = buildAuthorizedRatchetDm({ authorization: fencedAuthorization,
    ratchetCiphertext: 'interrupted-lifecycle-transition',
    applicationPayload: { kind: 'message', text: 'must not commit after invalidation' },
    senderDeviceSecret: alice.primaryDevice.deviceSecret, recipientDevicePubkey: bob.device.devicePubkey,
    createdAt: now + 8 }).wrap;
  const receivePaused = await bobTabs[0].evaluate(async (input) => {
    const { openDBFor, db } = await import('/src/db.js');
    const { setAtRestKeyProvider } = await import('/src/lib/messageAtRest.js');
    const { createSecurityContextFence, establishSecurityContext, SECURITY_CONTEXT_KEY } = await import('/src/lib/securityContextFence.js');
    const { commitRatchetInboundV2 } = await import('/src/lib/dmRatchetTransactions.js');
    setAtRestKeyProvider(() => Uint8Array.from(input.vaultKey));
    const context = establishSecurityContext({ owner: input.owner });
    const channel = new BroadcastChannel(`${SECURITY_CONTEXT_KEY}:invalidate`);
    const securityFence = createSecurityContextFence({ context, channel });
    window.__securityFence = securityFence;
    window.__securityChannel = channel;
    openDBFor(input.owner);
    await db.open();
    const paused = new Promise((resolve) => { window.__resumeLifecycle = resolve; });
    window.__pendingRatchetReceive = commitRatchetInboundV2({ owner: input.owner,
      deviceId: input.deviceId, recipientDeviceSecret: Uint8Array.from(input.recipientDeviceSecret),
      senderCheckpoint: input.senderCheckpoint, recipientCheckpoint: input.recipientCheckpoint,
      recipientRequesterDeviceId: input.recipientRequesterDeviceId, wrap: input.wrap,
      expectedVersion: null, securityFence, now: input.nowMs,
      processRatchetMessage: async ({ applicationPayload }) => {
        await paused;
        return { sessionId: 'invalidated-before-ratchet-commit', sessionState: { key: 'must-not-save' },
          chatId: 'chat', journal: { payload: applicationPayload } };
      } });
    window.__pendingRatchetReceive.catch(() => {});
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const claim = await db.ratchetInbox.get(input.operationId);
      if (claim?.status === 'processing') return true;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return false;
  }, { owner: bob.checkpoint.accountPubkey, deviceId: bob.device.deviceId,
    recipientDeviceSecret: Array.from(bob.device.deviceSecret), senderCheckpoint: alice.checkpoint,
    recipientCheckpoint: bob.checkpoint, recipientRequesterDeviceId: bob.primaryDevice.deviceId,
    wrap: fencedMessage, operationId: fencedOperationId, nowMs: (now + 9) * 1000, vaultKey });
  if (!receivePaused) throw new Error('The lifecycle race fixture did not reserve the inbound operation.');
  await bobTabs[1].evaluate(async (owner) => {
    const { invalidateSecurityContext, SECURITY_CONTEXT_KEY } = await import('/src/lib/securityContextFence.js');
    const channel = new BroadcastChannel(`${SECURITY_CONTEXT_KEY}:invalidate`);
    const result = invalidateSecurityContext({ owner, channel });
    channel.close();
    if (!result.persisted) throw new Error(`Could not durably invalidate the account: ${JSON.stringify(result)}`);
  }, bob.checkpoint.accountPubkey);
  const interrupted = await bobTabs[0].evaluate(async (operationId) => {
    for (let attempt = 0; attempt < 100 && window.__securityFence.isCurrent(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const invalidated = !window.__securityFence.isCurrent();
    window.__resumeLifecycle?.();
    const result = await window.__pendingRatchetReceive.then(() => ({ committed: true }), (error) => ({ committed: false, error: error.message }));
    const { db } = await import('/src/db.js');
    return { ...result, invalidated,
      session: await db.ratchetSessions.get('invalidated-before-ratchet-commit'),
      inbox: await db.ratchetInbox.get(operationId) };
  }, fencedOperationId);
  if (interrupted.committed || !interrupted.invalidated || interrupted.session || interrupted.inbox) {
    throw new Error(`A locked context committed a delayed ratchet transition: ${JSON.stringify(interrupted)}`);
  }

  // Reload an Alice tab to model a crash after IndexedDB commit and before relay
  // acknowledgement. The exact event and advanced state must remain recoverable.
  await aliceTabs[0].reload();
  const recovered = await aliceTabs[0].evaluate(async (input) => {
    const { openDBFor, db } = await import('/src/db.js');
    const { setAtRestKeyProvider } = await import('/src/lib/messageAtRest.js');
    const { loadRatchetState } = await import('/src/lib/dmRatchetTransactions.js');
    setAtRestKeyProvider(() => Uint8Array.from(input.vaultKey));
    openDBFor(input.accountPubkey);
    await db.open();
    const row = await db.outbox.get(input.eventId);
    const state = await loadRatchetState({ owner: input.accountPubkey, collection: 'sessions',
      id: 'browser-two-account-session', table: db.ratchetSessions });
    return { eventId: row?.event?.id, operationId: row?.ratchetDelivery?.operationId, version: state?.version };
  }, { accountPubkey: alice.checkpoint.accountPubkey, eventId: races[0].result.eventId, vaultKey });
  if (recovered.eventId !== races[0].result.eventId || recovered.operationId !== operationId || recovered.version !== 0) {
    throw new Error('Ratchet outbox/state did not survive browser reload recovery.');
  }

  console.log('R5 authority-to-ratchet browser harness: 2 independent accounts; concurrent tabs converged; NIP-59 relay frame hid account keys; receiver applied one effect; forced expired retry held; reload recovered exact event/state.');
  console.log('Lifecycle fence check: account-scoped invalidation reached a second tab and prevented a paused receive from committing.');
  await aliceContext.close();
  await bobContext.close();
} finally {
  await browser?.close();
  await vite.close();
}

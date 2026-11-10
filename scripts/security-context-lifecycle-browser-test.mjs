import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { getPublicKey } from 'nostr-tools/pure';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.VITE_TEST_HOOKS = '1';
process.env.CIPHER_UI_TEST_BUILD = '1';
const vite = await createViteServer({ configFile: path.join(root, 'vite.config.js'),
  server: { host: '127.0.0.1', port: 8098, strictPort: true }, appType: 'custom',
  // Several UI fixtures import lucide-react's public barrel, which otherwise
  // makes Chromium request hundreds of individual icon modules during a cold
  // dev-server boot. Prebundle that existing dependency so the browser gate
  // measures lifecycle behavior instead of waiting on the icon graph.
  optimizeDeps: { noDiscovery: true, include: ['dexie', 'lucide-react', 'react', 'react-dom/client'] } });
vite.middlewares.use((request, response, next) => {
  if (request.url !== '/__security_context_lifecycle_test') return next();
  const html = '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/lib/securityContextLifecycleProbe.jsx"></script></body></html>';
  vite.transformIndexHtml(request.url, html).then((transformed) => {
    response.setHeader('content-type', 'text/html');
    response.end(transformed);
  }).catch(next);
});

let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
  for (const [label, page] of [['first', first], ['second', second]]) {
    page.on('pageerror', (error) => console.error(`[${label} browser error]`, error));
    page.on('console', (message) => { if (message.type() === 'error') console.error(`[${label} console]`, message.text()); });
    page.on('requestfailed', (request) => console.error(`[${label} request failed]`, request.url(), request.failure()?.errorText));
    page.on('response', (response) => {
      if (response.status() >= 400) console.error(`[${label} response]`, response.status(), response.url());
    });
  }
  // The fixture imports the app's real React/identity graph. Vite's first
  // dependency optimization can be slow on a cold cache, and navigating both
  // pages at once used to make the second request compete with that scan until
  // Playwright timed out before either probe mounted. Let the first page warm
  // the graph before opening the sibling tab.
  await first.goto('http://127.0.0.1:8098/__security_context_lifecycle_test', {
    waitUntil: 'domcontentloaded', timeout: 60_000,
  });
  await second.goto('http://127.0.0.1:8098/__security_context_lifecycle_test', {
    waitUntil: 'domcontentloaded', timeout: 60_000,
  });
  const boot = await Promise.all([first, second].map(async (page) => {
    try {
      await page.waitForFunction(() => window.__identity && !window.__identity.loadingSession, null, { timeout: 30_000 });
      return null;
    } catch (error) {
      return { error: error.message, state: await page.evaluate(() => ({ title: document.title,
        body: document.body.innerText.slice(0, 500), html: document.documentElement.outerHTML.slice(0, 800),
        identity: Boolean(window.__identity), loadingSession: window.__identity?.loadingSession,
        readyState: document.readyState, resources: performance.getEntriesByType('resource').map((entry) => entry.name).slice(-8),
        path: location.pathname })) };
    }
  }));
  if (boot.some(Boolean)) throw new Error(`Lifecycle probe did not mount: ${JSON.stringify(boot.filter(Boolean))}`);

  const restored = await first.evaluate(async () => {
    const result = await window.__identity.restoreFromMnemonic(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '12345678');
    if (!result.success) throw new Error(`Account fixture restore failed: ${result.error}`);
    return result;
  });
  await first.waitForFunction(() => window.__identity.pk && window.__identity.securityFence?.isCurrent());
  const account = await first.evaluate(() => {
    return { owner: window.__identity.pk, incarnation: window.__identity.securityFence?.context?.incarnation,
      current: window.__identity.securityFence?.isCurrent() };
  });
  if (!restored.success || !account.owner || !account.incarnation || !account.current) throw new Error(`Restore did not establish a live lifecycle context: ${JSON.stringify({ restored, account })}`);

  const unlock = await second.evaluate(async () => {
    const result = await window.__identity.unlock('12345678');
    if (!result.success) throw new Error(`Second-tab unlock failed: ${result.error}`);
    return result;
  });
  await second.waitForFunction(() => window.__identity.pk && window.__identity.securityFence?.isCurrent());
  const unlocked = await second.evaluate(() => {
    return { owner: window.__identity.pk, incarnation: window.__identity.securityFence?.context?.incarnation,
      current: window.__identity.securityFence?.isCurrent() };
  });
  if (!unlock.success || unlocked.owner !== account.owner || unlocked.incarnation === account.incarnation || !unlocked.current) {
    throw new Error(`A second tab did not join the existing account lifecycle without replacing it: ${JSON.stringify({ unlock, unlocked })}`);
  }

  // Standalone authority writes share the account retirement Web Lock and
  // durable coordination marker. Hold primary-authority sealing in flight,
  // lock its tab, and prove retirement waits and the stale write leaves no row.
  await first.evaluate(async () => {
    const { createDeviceAuthoritySetup } = await import('/src/lib/deviceAuthority.js');
    const { storePrimaryAuthoritySecret } = await import('/src/lib/deviceAuthorityStorage.js');
    const identity = window.__identity;
    const state = createDeviceAuthoritySetup({ accountPubkey: identity.pk, now: Math.floor(Date.now() / 1000) });
    const subtle = crypto.subtle;
    window.__authorityGenerateEntered = false;
    const delayedCrypto = {
      getRandomValues: crypto.getRandomValues.bind(crypto),
      subtle: {
        generateKey: (...args) => new Promise((resolve) => {
          window.__authorityGenerateEntered = true;
          window.__releaseAuthorityGenerate = () => resolve(subtle.generateKey(...args));
        }),
        encrypt: subtle.encrypt.bind(subtle),
        decrypt: subtle.decrypt.bind(subtle),
      },
    };
    window.__authorityWrite = storePrimaryAuthoritySecret({ ...state,
      primaryDeviceSecret: state.primaryDevice.deviceSecret,
      expectedRecoveryPubkey: JSON.parse(state.policyEvent.content).recoveryPubkey,
      securityFence: identity.securityFence, cryptoImpl: delayedCrypto,
    }).then(() => ({ saved: true }), (error) => ({ saved: false, code: error?.code, error: error?.message }));
  });
  await first.waitForFunction(() => window.__authorityGenerateEntered === true);
  await first.evaluate(() => {
    window.__authorityLockDone = false;
    window.__authorityLock = window.__identity.lockApp().then(() => { window.__authorityLockDone = true; });
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const waitedForAuthority = await first.evaluate(() => !window.__authorityLockDone);
  if (!waitedForAuthority) throw new Error('Account lock did not wait for the in-flight standalone authority transaction.');
  await first.evaluate(() => window.__releaseAuthorityGenerate());
  const retiredAuthority = await first.evaluate(async () => {
    const write = await window.__authorityWrite;
    await window.__authorityLock;
    return { write, locked: window.__identity.pk === null };
  });
  retiredAuthority.rowPresent = await first.evaluate(async (accountOwner) => new Promise((resolve, reject) => {
      const request = indexedDB.open(`CipherPrimaryAuthorityV2_${accountOwner.slice(0, 24)}`, 1);
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('authority')) { database.close(); resolve(null); return; }
        const tx = database.transaction('authority', 'readonly');
        const get = tx.objectStore('authority').get(accountOwner);
        get.onsuccess = () => { const value = get.result || null; database.close(); resolve(value); };
        get.onerror = () => { database.close(); reject(get.error); };
      };
      request.onerror = () => reject(request.error);
    }), account.owner);
  retiredAuthority.rowPresent = !!retiredAuthority.rowPresent;
  if (retiredAuthority.write.saved || retiredAuthority.write.code !== 'SECURITY_CONTEXT_EXPIRED'
    || !retiredAuthority.locked || retiredAuthority.rowPresent) {
    throw new Error(`The standalone authority write crossed account retirement: ${JSON.stringify(retiredAuthority)}`);
  }
  const siblingAuthorityAccess = await second.evaluate(async () => {
    const { withSharedSecurityContext } = await import('/src/lib/securityContextCoordination.js');
    return withSharedSecurityContext(window.__identity.securityFence, async () => true);
  });
  if (!siblingAuthorityAccess) throw new Error('Local lock retired its still-unlocked sibling tab context.');
  const authorityRaceUnlock = await first.evaluate(async () => window.__identity.unlock('12345678'));
  if (!authorityRaceUnlock.success) throw new Error(`Could not reopen the authority-race tab: ${authorityRaceUnlock.error}`);
  await first.waitForFunction(() => window.__identity.pk && window.__identity.securityFence?.isCurrent());

  // The recovery-pin store has a separate browser database but shares the
  // local account's cross-tab coordinator. Race two valid recovery-root
  // successors from two unlocked incarnations; exactly one may advance the
  // saved contact pin.
  const pinForks = await first.evaluate(async () => {
    const { createDeviceAuthoritySetup, replaceDeviceAuthority } = await import('/src/lib/deviceAuthority.js');
    const now = Math.floor(Date.now() / 1000);
    const state = createDeviceAuthoritySetup({ accountPubkey: window.__identity.pk, now });
    const expectedRecoveryPubkey = JSON.parse(state.policyEvent.content).recoveryPubkey;
    const replacementA = replaceDeviceAuthority({ currentPolicyEvent: state.policyEvent,
      recoverySecret: state.recoverySecret, now: now + 1 });
    const replacementB = replaceDeviceAuthority({ currentPolicyEvent: state.policyEvent,
      recoverySecret: state.recoverySecret, now: now + 2 });
    return { now, policyEvent: state.policyEvent, expectedRecoveryPubkey,
      replacementA: replacementA.policyEvent, replacementB: replacementB.policyEvent };
  });
  const pinInitialization = await Promise.all([first, second].map((page) => page.evaluate(async ({ fixture }) => {
    const { pinInitialDeviceAuthorityPolicy } = await import('/src/lib/deviceAuthorityPinStore.js');
    try {
      const result = await pinInitialDeviceAuthorityPolicy({ policyEvent: fixture.policyEvent,
        expectedAccountPubkey: window.__identity.pk, expectedRecoveryPubkey: fixture.expectedRecoveryPubkey,
        now: fixture.now + 20, securityFence: window.__identity.securityFence });
      return { ok: true, result };
    } catch (error) { return { ok: false, error: error.message }; }
  }, { fixture: pinForks })));
  if (pinInitialization.some((row) => !row.ok)) {
    throw new Error(`Two tabs could not converge on the same independently supplied contact pin: ${JSON.stringify(pinInitialization)}`);
  }
  const pinForkRace = await Promise.all([first, second].map((page, index) => page.evaluate(async ({ fixture, successor }) => {
    const { advanceDeviceAuthorityPolicyPin } = await import('/src/lib/deviceAuthorityPinStore.js');
    try {
      const result = await advanceDeviceAuthorityPolicyPin({ currentPolicyEvent: fixture.policyEvent,
        nextPolicyEvent: successor, expectedAccountPubkey: window.__identity.pk,
        expectedRecoveryPubkey: fixture.expectedRecoveryPubkey, now: fixture.now + 20,
        securityFence: window.__identity.securityFence });
      return { ok: true, result };
    } catch (error) { return { ok: false, error: error.message }; }
  }, { fixture: pinForks, successor: index === 0 ? pinForks.replacementA : pinForks.replacementB })));
  if (pinForkRace.filter((row) => row.ok).length !== 1 || pinForkRace.filter((row) => !row.ok).length !== 1) {
    throw new Error(`Concurrent recovery-pin successors did not converge on one exact head: ${JSON.stringify(pinForkRace)}`);
  }
  const pinnedHeads = await Promise.all([first, second].map((page) => page.evaluate(async ({ fixture }) => {
    const { loadPinnedDeviceAuthorityPolicy } = await import('/src/lib/deviceAuthorityPinStore.js');
    const state = await loadPinnedDeviceAuthorityPolicy({ expectedAccountPubkey: window.__identity.pk,
      expectedRecoveryPubkey: fixture.expectedRecoveryPubkey, now: fixture.now + 20,
      securityFence: window.__identity.securityFence });
    return state.policyId;
  }, { fixture: pinForks })));
  if (pinnedHeads[0] !== pinnedHeads[1]
    || ![pinForks.replacementA.id, pinForks.replacementB.id].includes(pinnedHeads[0])) {
    throw new Error(`Pin readers observed different or unexpected heads: ${JSON.stringify(pinnedHeads)}`);
  }

  // Repeat the competing-successor race for the remote peer checkpoint store.
  // This store is prototype-only and has no live application caller.
  const peerForks = await first.evaluate(async () => {
    const { createDeviceAuthoritySetup, createIndependentDeviceCredential,
      createDeviceEnrollmentChallengeV2, buildDeviceEnrollmentProofV2,
      enrollDeviceV2 } = await import('/src/lib/deviceAuthority.js');
    const now = Math.floor(Date.now() / 1000);
    const state = createDeviceAuthoritySetup({ accountPubkey: window.__identity.pk, now });
    const createUpdate = () => {
      const device = createIndependentDeviceCredential();
      const challengeEvent = createDeviceEnrollmentChallengeV2({ policyEvent: state.policyEvent,
        registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
        authoritySecret: state.authoritySecret, deviceId: device.deviceId,
        devicePubkey: device.devicePubkey, now: now + 1 });
      const proofEvent = buildDeviceEnrollmentProofV2({ challengeEvent,
        policyEvent: state.policyEvent, registryEvent: state.registryEvent,
        expectedRegistryId: state.registryEvent.id, deviceSecret: device.deviceSecret, now: now + 2 });
      const nextRegistryEvent = enrollDeviceV2({ policyEvent: state.policyEvent,
        registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
        challengeEvent, proofEvent, authoritySecret: state.authoritySecret, now: now + 3 });
      return { type: 'registry-update', policyEvent: state.policyEvent,
        previousRegistryEvent: state.registryEvent, nextRegistryEvent };
    };
    return { now, policyEvent: state.policyEvent, registryEvent: state.registryEvent,
      recoveryPubkey: JSON.parse(state.policyEvent.content).recoveryPubkey,
      updateA: createUpdate(), updateB: createUpdate() };
  });
  const peerInitialization = await Promise.all([first, second].map((page) => page.evaluate(async ({ fixture }) => {
    const { initializePeerDeviceAuthority } = await import('/src/lib/deviceAuthorityPeerStore.js');
    try {
      const result = await initializePeerDeviceAuthority({ policyEvent: fixture.policyEvent,
        registryEvent: fixture.registryEvent, expectedAccountPubkey: window.__identity.pk,
        expectedRecoveryPubkey: fixture.recoveryPubkey, now: fixture.now + 20,
        securityFence: window.__identity.securityFence });
      return { ok: true, result };
    } catch (error) { return { ok: false, error: error.message }; }
  }, { fixture: peerForks })));
  if (peerInitialization.some((row) => !row.ok)) {
    throw new Error(`Two tabs could not converge on the same peer checkpoint: ${JSON.stringify(peerInitialization)}`);
  }
  const peerForkRace = await Promise.all([first, second].map((page, index) => page.evaluate(async ({ fixture, update }) => {
    const { applyPeerDeviceRegistryUpdate } = await import('/src/lib/deviceAuthorityPeerStore.js');
    try {
      const result = await applyPeerDeviceRegistryUpdate({ update,
        expectedAccountPubkey: window.__identity.pk, expectedRecoveryPubkey: fixture.recoveryPubkey,
        now: fixture.now + 20, securityFence: window.__identity.securityFence });
      return { ok: true, result };
    } catch (error) { return { ok: false, error: error.message }; }
  }, { fixture: peerForks, update: index === 0 ? peerForks.updateA : peerForks.updateB })));
  if (peerForkRace.filter((row) => row.ok).length !== 1 || peerForkRace.filter((row) => !row.ok).length !== 1) {
    throw new Error(`Concurrent peer-registry successors did not converge on one exact head: ${JSON.stringify(peerForkRace)}`);
  }
  const peerHeads = await Promise.all([first, second].map((page) => page.evaluate(async ({ fixture }) => {
    const { loadPeerDeviceAuthority } = await import('/src/lib/deviceAuthorityPeerStore.js');
    return (await loadPeerDeviceAuthority({ expectedAccountPubkey: window.__identity.pk,
      expectedRecoveryPubkey: fixture.recoveryPubkey, now: fixture.now + 20,
      securityFence: window.__identity.securityFence })).registryId;
  }, { fixture: peerForks })));
  const acceptedPeerHead = peerForkRace.find((row) => row.ok).result.registryId;
  if (peerHeads[0] !== acceptedPeerHead || peerHeads[1] !== acceptedPeerHead) {
    throw new Error(`Peer checkpoint readers observed divergent registry heads: ${JSON.stringify({ peerHeads, acceptedPeerHead })}`);
  }

  // Exercise cross-tab owner retirement while one IndexedDB resource reports a
  // failure. The central marker must remain; after repairing that resource,
  // retry removes all owner markers but leaves an unrelated sibling owner.
  const retirementFixture = await first.evaluate(async () => {
    const { activateSharedSecurityContext } = await import('/src/lib/securityContextCoordination.js');
    const owner = 'c'.repeat(64);
    const contexts = [
      { owner, incarnation: 'a'.repeat(32) },
      { owner, incarnation: 'b'.repeat(32) },
      { owner: 'd'.repeat(64), incarnation: 'c'.repeat(32) },
    ];
    const fences = contexts.map((context) => ({ context, assertCurrent() {} }));
    await Promise.all(fences.map((fence) => activateSharedSecurityContext(fence)));
    window.__retirementFixture = { owner, contexts };
    window.__retirementLockEntered = false;
    window.__retirementLock = navigator.locks.request(`cipher-security-context:${owner}`, async () => {
      window.__retirementLockEntered = true;
      await new Promise((resolve) => { window.__releaseRetirementLock = resolve; });
    });
    return { owner, contexts };
  });
  await first.waitForFunction(() => window.__retirementLockEntered === true);
  await second.evaluate(async ({ fixture }) => {
    const { withSharedSecurityContext, retireOwnerSharedSecurityContexts } = await import('/src/lib/securityContextCoordination.js');
    const { retireAccountDatabaseContexts } = await import('/src/db.js');
    const { retireAccountBitcoinAllocationContexts } = await import('/src/lib/commerceWalletStore.js');
    const [writerContext, siblingContext] = fixture.contexts;
    window.__retirementFixture = fixture;
    const writerFence = { context: writerContext, assertCurrent() {} };
    const siblingFence = { context: siblingContext, assertCurrent() {} };
    window.__retirementProbe = { writerDone: false, retirementDone: false };
    window.__retirementWriter = withSharedSecurityContext(writerFence, async () => 'write-completed')
      .then((value) => { window.__retirementProbe.writerDone = true; return { ok: true, value }; },
        (error) => { window.__retirementProbe.writerDone = true; return { ok: false, error: error.message }; });
    window.__failedRetirement = retireOwnerSharedSecurityContexts(fixture.owner, async () => {
      const database = await retireAccountDatabaseContexts(fixture.owner);
      const blockedAllocator = await retireAccountBitcoinAllocationContexts(fixture.owner, {
        open() { throw new Error('injected allocator database open failure'); },
      });
      return { retired: database.retired && blockedAllocator.retired,
        database, allocator: blockedAllocator };
    }).then((value) => { window.__retirementProbe.retirementDone = true; return value; },
      (error) => { window.__retirementProbe.retirementDone = true; return { retired: false, error: error.message }; });
    window.__retirementSiblingFence = siblingFence;
  }, { fixture: retirementFixture });
  await new Promise((resolve) => setTimeout(resolve, 75));
  const blockedRetirement = await second.evaluate(() => ({ ...window.__retirementProbe }));
  if (blockedRetirement.writerDone || blockedRetirement.retirementDone) {
    throw new Error(`A cross-tab owner lock did not hold in-flight work: ${JSON.stringify(blockedRetirement)}`);
  }
  await first.evaluate(() => window.__releaseRetirementLock());
  const failedRetirement = await second.evaluate(async () => ({
    writer: await window.__retirementWriter,
    retirement: await window.__failedRetirement,
  }));
  if (!failedRetirement.writer.ok || failedRetirement.retirement.retired
    || failedRetirement.retirement.resources?.database?.retired !== true
    || failedRetirement.retirement.resources?.allocator?.retired !== false) {
    throw new Error(`A single allocator failure did not hold owner retirement safely: ${JSON.stringify(failedRetirement)}`);
  }
  const retainedMarkers = await second.evaluate(async ({ siblingOwner }) => {
    const { withSharedSecurityContext } = await import('/src/lib/securityContextCoordination.js');
    const contexts = window.__retirementFixture.contexts;
    const canWrite = await Promise.all(contexts.slice(0, 2).map((context) => withSharedSecurityContext(
      { context, assertCurrent() {} }, async () => true).catch(() => false)));
    return { canWrite, siblingOwnerActive: await withSharedSecurityContext(
      { context: { owner: siblingOwner, incarnation: 'c'.repeat(32) }, assertCurrent() {} },
      async () => true).catch(() => false) };
  }, { siblingOwner: retirementFixture.contexts[2].owner });
  if (retainedMarkers.canWrite.filter(Boolean).length !== 2 || !retainedMarkers.siblingOwnerActive) {
    throw new Error(`Failed retirement removed active markers or harmed an unrelated owner: ${JSON.stringify(retainedMarkers)}`);
  }
  const recoveredRetirement = await second.evaluate(async ({ owner }) => {
    const { retireOwnerSharedSecurityContexts, withSharedSecurityContext } = await import('/src/lib/securityContextCoordination.js');
    const { retireAccountDatabaseContexts } = await import('/src/db.js');
    const { retireAccountBitcoinAllocationContexts } = await import('/src/lib/commerceWalletStore.js');
    const result = await retireOwnerSharedSecurityContexts(owner, async () => {
      const [database, allocator] = await Promise.all([
        retireAccountDatabaseContexts(owner), retireAccountBitcoinAllocationContexts(owner),
      ]);
      return { retired: database.retired && allocator.retired, database, allocator };
    });
    const contexts = window.__retirementFixture.contexts;
    const staleWritesBlocked = await Promise.all(contexts.slice(0, 2).map((context) => withSharedSecurityContext(
      { context, assertCurrent() {} }, async () => true).then(() => false, () => true)));
    const unrelatedOwnerStillActive = await withSharedSecurityContext(
      { context: contexts[2], assertCurrent() {} }, async () => true).catch(() => false);
    return { result, staleWritesBlocked, unrelatedOwnerStillActive };
  }, { owner: retirementFixture.owner });
  if (!recoveredRetirement.result.retired || recoveredRetirement.staleWritesBlocked.some((ok) => !ok)
    || !recoveredRetirement.unrelatedOwnerStillActive) {
    throw new Error(`Retry after database recovery did not retire only the target owner: ${JSON.stringify(recoveredRetirement)}`);
  }

  const allocation = await first.evaluate(async () => {
    const { activateBitcoinAllocationContext, initializeBitcoinDescriptor, reserveBitcoinIndex } = await import('/src/lib/commerceWalletStore.js');
    const identity = window.__identity;
    window.__allocatorFence = identity.securityFence;
    const descriptor = 'browser-lifecycle-wallet-descriptor';
    await activateBitcoinAllocationContext(identity.securityFence);
    await initializeBitcoinDescriptor({ owner: identity.pk, descriptor, explicitlyNew: true,
      securityFence: identity.securityFence });
    const reservation = await reserveBitcoinIndex({ owner: identity.pk, descriptor,
      orderId: 'browser-first-allocation', securityFence: identity.securityFence });
    return { descriptor, index: reservation.index };
  });
  if (allocation.index !== 1) throw new Error(`The first browser allocator reservation was unexpected: ${JSON.stringify(allocation)}`);

  const paymentFixture = await first.evaluate(async ({ peer }) => {
    const { db, openDBFor, waitForSecurityContextActivation, saveMessage } = await import('/src/db.js');
    const identity = window.__identity;
    const orderId = `lifecycle-payment-order-${identity.pk.slice(0, 12)}`;
    const issuedAt = Math.floor(Date.now() / 1000) - 30;
    openDBFor(identity.pk, identity.securityFence);
    await waitForSecurityContextActivation();
    await saveMessage(peer, { id: orderId, isSender: false, pubkey: peer, type: 'cipher_order', timestamp: issuedAt,
      data: { type: 'cipher_order', status: 'pending', product: { title: 'Lifecycle fixture', currency: 'xmr' } } });
    await saveMessage(peer, { id: `lifecycle-payment-acceptance-${identity.pk.slice(0, 12)}`, isSender: true,
      pubkey: identity.pk, timestamp: issuedAt + 1, data: { type: 'order_update', orderId, status: 'accepted',
        paymentState: 'address_issued', paymentMethods: { xmr: '8fixture-per-order-address' },
        coinCurrency: 'xmr', coinAmount: '0.5', issuedAt } });
    const history = await db.messages.where('chatId').equals(peer).toArray();
    if (!history.some((message) => message.id === orderId)
      || !history.some((message) => message.data?.type === 'order_update' && message.data.orderId === orderId)) {
      throw new Error('Could not persist the lifecycle payment order and acceptance fixture.');
    }
    const saved = await window.__identity.securityFence.isCurrent();
    if (!saved) throw new Error('Payment fixture account context expired while seeding the order.');
    const { scopedRaw } = await import('/src/lib/storage.js');
    return { peer, orderId, issuedAt, receiptKey: `cipher_${identity.pk}_receipt_${orderId}`,
      ledgerKey: `cipher_${identity.pk}_consumed_txids`, initialReceipt: scopedRaw(`receipt_${orderId}`, null),
      initialLedger: scopedRaw('consumed_txids', null) };
  }, { peer: getPublicKey(new Uint8Array(32).fill(29)) });
  if (paymentFixture.initialReceipt != null || paymentFixture.initialLedger != null) {
    throw new Error(`Payment fixture storage was not clean before the race: ${JSON.stringify(paymentFixture)}`);
  }
  await first.evaluate(({ peer, orderId, issuedAt }) => {
    window.__orderUpdatePublishes = [];
    window.__commerceUiEffects = [];
    window.__paymentCheckEntered = false;
    window.__cipherPaymentCheck = () => new Promise((resolve) => {
      window.__resolvePaymentCheck = () => resolve({ moved: true, state: 'confirmed', report: {
        txid: 'lifecycle-fixture-transfer', time: issuedAt + 2, amount: '0.5',
      } });
      window.__paymentCheckEntered = true;
    });
    window.__paymentAttempt = window.__commerce.handleOrderAction('check_chain', {
      id: orderId, pubkey: peer, isSender: false,
      data: { type: 'cipher_order', status: 'pending', product: { title: 'Lifecycle fixture', currency: 'xmr' } },
    });
  }, paymentFixture);
  await first.waitForFunction(() => window.__paymentCheckEntered === true);
  await first.evaluate(() => window.__identity.lockApp());
  await first.evaluate(() => {
    window.__commerceUiEffects = [];
    window.__orderUpdatePublishes = [];
  });
  await first.evaluate(() => window.__resolvePaymentCheck());
  const retiredPayment = await first.evaluate(async ({ receiptKey, ledgerKey }) => {
    const result = await window.__paymentAttempt;
    return { result, receipt: localStorage.getItem(receiptKey), ledger: localStorage.getItem(ledgerKey),
      publishes: window.__orderUpdatePublishes.length, uiEffects: window.__commerceUiEffects.length };
  }, paymentFixture);
  if (retiredPayment.result !== true || retiredPayment.receipt !== null || retiredPayment.ledger !== null || retiredPayment.publishes !== 0
    || retiredPayment.uiEffects !== 0) {
    throw new Error(`A retired payment-check context produced an effect: ${JSON.stringify(retiredPayment)}`);
  }
  await second.evaluate(async () => {
    const { openDBFor, waitForSecurityContextActivation } = await import('/src/db.js');
    openDBFor(window.__identity.pk, window.__identity.securityFence);
    await waitForSecurityContextActivation();
  });
  const siblingPayment = await second.evaluate(async ({ peer, orderId, issuedAt }) => {
    window.__orderUpdatePublishes = [];
    window.__commerceUiEffects = [];
    window.__cipherPaymentCheck = async () => ({ moved: true, state: 'confirmed', report: {
      txid: 'lifecycle-fixture-transfer', time: issuedAt + 2, amount: '0.5',
    } });
    const result = await window.__commerce.handleOrderAction('check_chain', {
      id: orderId, pubkey: peer, isSender: false,
      data: { type: 'cipher_order', status: 'pending', product: { title: 'Lifecycle fixture', currency: 'xmr' } },
    });
    const { scopedRaw } = await import('/src/lib/storage.js');
    return { result, receipt: scopedRaw(`receipt_${orderId}`, null), ledger: scopedRaw('consumed_txids', null),
      publishes: window.__orderUpdatePublishes.length, current: window.__identity.securityFence?.isCurrent() };
  }, paymentFixture);
  if (siblingPayment.result !== true || !siblingPayment.current || siblingPayment.publishes !== 1
    || !siblingPayment.receipt || !siblingPayment.ledger) {
    throw new Error(`The still-current sibling context failed the payment-check control: ${JSON.stringify(siblingPayment)}`);
  }

  // Browser-only lifecycle probes exercise the actual UI hooks/callbacks. The
  // relay, watcher, and media host endpoints are deliberate test doubles.
  const uiPeer = getPublicKey(new Uint8Array(32).fill(37));
  const uiUnlock = await first.evaluate(() => window.__identity.unlock('12345678'));
  if (!uiUnlock.success) throw new Error(`UI-race account unlock failed: ${uiUnlock.error}`);
  await first.waitForFunction(() => window.__identity.pk && window.__identity.securityFence?.isCurrent());
  await first.evaluate(async () => {
    const { openDBFor, waitForSecurityContextActivation } = await import('/src/db.js');
    openDBFor(window.__identity.pk, window.__identity.securityFence);
    await waitForSecurityContextActivation();
  });
  await first.evaluate(async () => {
    const { openDBFor, waitForSecurityContextActivation, db } = await import('/src/db.js');
    openDBFor(window.__identity.pk, window.__identity.securityFence);
    await waitForSecurityContextActivation();
    window.__capturedUiFence = window.__identity.securityFence;
    window.__lifecycleDbWrites = [];
    window.__retiredUiEffects = [];
    window.__lifecyclePublishes = [];
    window.__trackRetiredEffects = false;
    for (const tableName of ['messages', 'chatReads', 'outbox']) {
      const table = db[tableName];
      for (const method of ['add', 'put', 'update', 'delete', 'bulkAdd', 'bulkPut', 'clear']) {
        if (typeof table[method] !== 'function') continue;
        const original = table[method].bind(table);
        table[method] = (...args) => {
          if (window.__trackRetiredEffects && !window.__capturedUiFence?.isCurrent()) {
            window.__lifecycleDbWrites.push(`${table.name}.${method}`);
          }
          return original(...args);
        };
      }
    }
    window.__lifecycleHolds = {};
    window.__lifecycleEntered = {};
    window.__cipherGroupMessage = async (...args) => {
      await new Promise((resolve) => {
        window.__lifecycleEntered['group-send'] = true;
        window.__release_group_send = resolve;
      });
      const capturedIdentity = args.at(-1);
      capturedIdentity.securityFence.assertCurrent();
      window.__lifecyclePublishes.push({ type: 'group', args });
      return { success: true, queued: false, event: { id: 'ui-group-event', created_at: Math.floor(Date.now() / 1000) } };
    };
    window.__cipherMediaUpload = async (_file, _servers, fence, owner, surface) => {
      window.__lifecycleEntered['media-upload'] = true;
      await new Promise((resolve) => { window.__release_media_upload = resolve; });
      window.__mediaHostAccepted = (window.__mediaHostAccepted || 0) + 1;
      fence.assertCurrent();
      window.__lifecyclePublishes.push({ type: `media-host:${surface}`, owner });
      return { url: 'https://media.invalid/encrypted-object', key: 'test-key', iv: 'test-iv' };
    };
    window.__cipherNotificationRead = async (_chatId, _fence, _owner) => {
      window.__lifecycleEntered['notification-read'] = true;
      await new Promise((resolve) => { window.__release_notification_read = resolve; });
      return true;
    };
  });

  await first.evaluate(async ({ peer }) => {
    window.__capturedUiFence = window.__identity.securityFence;
    window.__trackRetiredEffects = false;
    const store = window.__chatStore.getState();
    store.setActiveDm(peer);
    store.setView('dm');
    await new Promise((resolve) => setTimeout(resolve, 80));
    window.__lifecycleHolds['composer-send'] = true;
    window.__lifecycleEntered = {};
    window.__lifecyclePublishes = [];
    window.__lifecycleDbWrites = [];
    window.__retiredUiEffects = [];
    window.__composerAttempt = window.__composer.sendMessage('held during lock')
      .then((value) => ({ value }), (error) => ({ code: error?.code }));
  }, { peer: uiPeer });
  await first.waitForFunction(() => window.__lifecycleEntered['composer-send'] === true);
  await first.evaluate(() => window.__identity.lockApp());
  await first.waitForFunction(() => window.__identity.pk === null);
  await first.evaluate(() => { window.__trackRetiredEffects = true; window['__release_composer-send'](); });
  const composerRace = await first.evaluate(async () => ({
    result: await window.__composerAttempt,
    ui: window.__retiredUiEffects,
    writes: window.__lifecycleDbWrites,
    publishes: window.__lifecyclePublishes,
  }));
  if (composerRace.result.code !== 'SECURITY_CONTEXT_EXPIRED' || composerRace.ui.length || composerRace.writes.length || composerRace.publishes.length) {
    throw new Error(`Composer completion crossed a retired account fence: ${JSON.stringify(composerRace)}`);
  }

  const unlockFirst = async () => {
    const result = await first.evaluate(() => window.__identity.unlock('12345678'));
    if (!result.success) throw new Error(`UI-race account unlock failed: ${result.error}`);
    await first.waitForFunction(() => window.__identity.pk && window.__identity.securityFence?.isCurrent());
    await first.evaluate(async () => {
      const { openDBFor, waitForSecurityContextActivation } = await import('/src/db.js');
      openDBFor(window.__identity.pk, window.__identity.securityFence);
      await waitForSecurityContextActivation();
    });
  };

  await unlockFirst();
  await first.evaluate(({ peer }) => {
    window.__capturedUiFence = window.__identity.securityFence;
    window.__trackRetiredEffects = false;
    window.__lifecycleEntered = {};
    window.__lifecyclePublishes = [];
    window.__lifecycleDbWrites = [];
    window.__retiredUiEffects = [];
    window.__lifecycleHolds['message-reaction'] = true;
    window.__messageAttempt = window.__messageCommands.handleMessageAction('react', { id: 'reaction-target', emoji: '🔥', pubkey: peer });
  }, { peer: uiPeer });
  await first.waitForFunction(() => window.__lifecycleEntered['message-reaction'] === true);
  await first.evaluate(() => window.__identity.lockApp());
  await first.waitForFunction(() => window.__identity.pk === null);
  await first.evaluate(() => { window.__trackRetiredEffects = true; window['__release_message-reaction'](); });
  const messageActionRace = await first.evaluate(async () => ({
    result: await window.__messageAttempt,
    ui: window.__retiredUiEffects,
    writes: window.__lifecycleDbWrites,
    publishes: window.__lifecyclePublishes,
  }));
  if (messageActionRace.ui.length || messageActionRace.writes.length || messageActionRace.publishes.length) {
    throw new Error(`Message action completion crossed a retired account fence: ${JSON.stringify(messageActionRace)}`);
  }

  await unlockFirst();
  await first.evaluate(async ({ peer }) => {
    window.__capturedUiFence = window.__identity.securityFence;
    window.__trackRetiredEffects = false;
    const store = window.__chatStore.getState();
    store.setDms((current) => ({ ...current, [peer]: [] }));
    store.setUnreadCounts({ [peer]: 1 });
    window.__setLifecycleSurface('notifications');
    await new Promise((resolve) => setTimeout(resolve, 40));
    window.__lifecycleEntered = {};
    window.__lifecycleDbWrites = [];
    window.__retiredUiEffects = [];
    window.__notificationJumps = 0;
    window.__notificationAttempt = window.__notificationOpen({ id: peer, type: 'dm' });
  }, { peer: uiPeer });
  await first.waitForFunction(() => window.__lifecycleEntered['notification-read'] === true);
  await first.evaluate(() => window.__identity.lockApp());
  await first.waitForFunction(() => window.__identity.pk === null);
  await first.evaluate(() => { window.__trackRetiredEffects = true; window.__release_notification_read(); });
  const notificationRace = await first.evaluate(async () => ({
    result: await window.__notificationAttempt,
    jumps: window.__notificationJumps,
    ui: window.__retiredUiEffects,
    writes: window.__lifecycleDbWrites,
  }));
  if (notificationRace.jumps !== 0 || notificationRace.ui.length || notificationRace.writes.length) {
    throw new Error(`Notification continuation crossed a retired account fence: ${JSON.stringify(notificationRace)}`);
  }

  await unlockFirst();
  await first.evaluate(async () => {
    window.__capturedUiFence = window.__identity.securityFence;
    window.__trackRetiredEffects = false;
    const group = { id: 'ui-lifecycle-group', name: 'Lifecycle group', creator: window.__identity.pk };
    const store = window.__chatStore.getState();
    store.setActiveGroup(group);
    store.setActiveDm(null);
    store.setView('group');
    window.__setLifecycleSurface('group');
    await new Promise((resolve) => setTimeout(resolve, 80));
    window.__lifecycleEntered = {};
    window.__lifecyclePublishes = [];
    window.__lifecycleDbWrites = [];
    window.__retiredUiEffects = [];
  });
  await first.waitForFunction(() => window.__groupViewLifecycle && window.__identity.securityFence?.isCurrent());
  await first.evaluate(() => {
    window.__groupAttempt = window.__groupViewLifecycle.sendGroupText('held group message')
      .then((value) => ({ value }), (error) => ({ code: error?.code }));
  });
  await first.waitForFunction(() => window.__lifecycleEntered['group-send'] === true);
  await first.evaluate(() => window.__identity.lockApp());
  await first.waitForFunction(() => window.__identity.pk === null);
  await first.evaluate(() => { window.__trackRetiredEffects = true; window.__release_group_send(); });
  const groupSendRace = await first.evaluate(async () => ({
    result: await window.__groupAttempt,
    ui: window.__retiredUiEffects,
    writes: window.__lifecycleDbWrites,
    publishes: window.__lifecyclePublishes,
  }));
  if (groupSendRace.result.code !== 'SECURITY_CONTEXT_EXPIRED' || groupSendRace.ui.length || groupSendRace.writes.length || groupSendRace.publishes.length) {
    throw new Error(`Group send completion crossed a retired account fence: ${JSON.stringify(groupSendRace)}`);
  }

  await unlockFirst();
  await first.evaluate(() => {
    window.__capturedUiFence = window.__identity.securityFence;
    window.__trackRetiredEffects = false;
    const menu = Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Menu');
    menu?.click();
  });
  await first.waitForFunction(() => window.__groupPhotoUpload && window.__identity.securityFence?.isCurrent());
  await first.evaluate(() => {
    window.__lifecycleEntered = {};
    window.__lifecyclePublishes = [];
    window.__lifecycleDbWrites = [];
    window.__retiredUiEffects = [];
    window.__mediaHostAccepted = 0;
    window.__groupPhotoAttempt = window.__groupPhotoUpload({ target: {
      value: '', files: [new File(['fixture-image'], 'fixture.png', { type: 'image/png' })],
    } });
  });
  await first.waitForFunction(() => window.__lifecycleEntered['media-upload'] === true);
  await first.evaluate(() => window.__identity.lockApp());
  await first.waitForFunction(() => window.__identity.pk === null);
  await first.evaluate(() => { window.__trackRetiredEffects = true; window.__release_media_upload(); });
  const groupMediaRace = await first.evaluate(async () => ({
    acceptedAtMockHost: window.__mediaHostAccepted,
    ui: window.__retiredUiEffects,
    writes: window.__lifecycleDbWrites,
    publishes: window.__lifecyclePublishes,
  }));
  if (groupMediaRace.acceptedAtMockHost !== 1 || groupMediaRace.ui.length || groupMediaRace.writes.length || groupMediaRace.publishes.length) {
    throw new Error(`Group photo completion crossed a retired account fence: ${JSON.stringify(groupMediaRace)}`);
  }

  await unlockFirst();
  await first.evaluate(() => window.__setLifecycleSurface('wallet'));
  await first.waitForFunction(() => window.__walletLifecycle && window.__walletSettingsLifecycle
    && window.__identity.securityFence?.isCurrent());
  await first.evaluate(() => {
    window.__staleWalletSettings = window.__walletSettingsLifecycle;
    const owner = window.__identity.pk;
    const keys = {
      preferred: `cipher_${owner}_preferred_payment_method`,
      confirmations: `cipher_${owner}_confirmations`,
      autoVouch: `cipher_${owner}_auto_vouch_on_delivery`,
    };
    localStorage.setItem(keys.preferred, JSON.stringify('xmr'));
    localStorage.setItem(keys.confirmations, JSON.stringify({ btc: 4, xmr: 12 }));
    localStorage.setItem(keys.autoVouch, JSON.stringify(false));
    window.__walletSettingsBaseline = Object.fromEntries(Object.entries(keys)
      .map(([name, key]) => [name, localStorage.getItem(key)]));
    window.__capturedUiFence = window.__identity.securityFence;
    window.__trackRetiredEffects = false;
    window.__lifecycleEntered = {};
    window.__lifecyclePublishes = [];
    window.__lifecycleDbWrites = [];
    window.__retiredUiEffects = [];
    window.__mediaHostAccepted = 0;
    window.__walletMediaAttempt = window.__walletLifecycle.handleImageUpload({ target: {
      files: [new File(['fixture-image'], 'fixture.png', { type: 'image/png' })],
    } }, 'product');
  });
  await first.waitForFunction(() => window.__lifecycleEntered['media-upload'] === true);
  await first.evaluate(() => window.__identity.lockApp());
  await first.waitForFunction(() => window.__identity.pk === null);
  await first.evaluate(() => { window.__trackRetiredEffects = true; window.__release_media_upload(); });
  const walletMediaRace = await first.evaluate(async () => ({
    acceptedAtMockHost: window.__mediaHostAccepted,
    ui: window.__retiredUiEffects,
    writes: window.__lifecycleDbWrites,
    publishes: window.__lifecyclePublishes,
  }));
  if (walletMediaRace.acceptedAtMockHost !== 1 || walletMediaRace.ui.length || walletMediaRace.writes.length || walletMediaRace.publishes.length) {
    throw new Error(`Wallet photo completion crossed a retired account fence: ${JSON.stringify(walletMediaRace)}`);
  }

  const staleSettingsRace = await first.evaluate(() => {
    window.__staleWalletSettings.saveConfirmations({ preventDefault() {} });
    window.__staleWalletSettings.toggleAutoVouch();
    window.__staleWalletSettings.setPreferredPaymentMethod('btc');
    const owner = window.__identity.pk || window.__capturedUiFence.context.owner;
    const keys = {
      preferred: `cipher_${owner}_preferred_payment_method`,
      confirmations: `cipher_${owner}_confirmations`,
      autoVouch: `cipher_${owner}_auto_vouch_on_delivery`,
    };
    return Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, localStorage.getItem(key)]));
  });
  if (JSON.stringify(staleSettingsRace) !== JSON.stringify(await first.evaluate(() => window.__walletSettingsBaseline))) {
    throw new Error(`Retired Wallet settings callback changed stored preferences: ${JSON.stringify({ staleSettingsRace, baseline: await first.evaluate(() => window.__walletSettingsBaseline) })}`);
  }

  await unlockFirst();
  await first.evaluate(async () => {
    window.__capturedUiFence = window.__identity.securityFence;
    window.__trackRetiredEffects = false;
    const calls = [];
    const pool = { publish() { calls.push('publish'); return [Promise.resolve('accepted')]; }, close() {} };
    window.__cardPublishCalls = calls;
    window.__vendorCardEntered = false;
    window.__beforeVendorCardPublish = () => new Promise((resolve) => {
      window.__vendorCardEntered = true;
      window.__release_vendor_card = resolve;
    });
    window.__cardAttempt = window.__walletLifecycle.publishVendorCard(pool)
      .then((value) => ({ value }), (error) => ({ code: error?.code }));
  });
  await first.waitForFunction(() => window.__vendorCardEntered === true);
  await first.evaluate(() => window.__identity.lockApp());
  await first.waitForFunction(() => window.__identity.pk === null);
  await first.evaluate(() => window.__release_vendor_card());
  const cardRace = await first.evaluate(async () => ({ result: await window.__cardAttempt, calls: window.__cardPublishCalls }));
  if (cardRace.result.code !== 'SECURITY_CONTEXT_EXPIRED' || cardRace.calls.length !== 0) {
    throw new Error(`Vendor card publish crossed a retired pre-publish fence: ${JSON.stringify(cardRace)}`);
  }

  // Unlock again so the pre-existing allocator and account-removal controls
  // below run against a live tab just as before.
  await unlockFirst();

  const afterLocalLock = await second.evaluate(() => ({ owner: window.__identity.pk,
    current: window.__identity.securityFence?.isCurrent() }));
  if (afterLocalLock.owner !== account.owner || !afterLocalLock.current) {
    throw new Error('A local lock incorrectly invalidated the other unlocked tab.');
  }
  const staleAllocation = await first.evaluate(async ({ owner, descriptor }) => {
    const { reserveBitcoinIndex } = await import('/src/lib/commerceWalletStore.js');
    try {
      await reserveBitcoinIndex({ owner, descriptor, orderId: 'browser-stale-allocation',
        securityFence: window.__allocatorFence });
      return { rejected: false };
    } catch (error) { return { rejected: error?.code === 'SECURITY_CONTEXT_EXPIRED', code: error?.code }; }
  }, { owner: account.owner, descriptor: allocation.descriptor });
  if (!staleAllocation.rejected) throw new Error(`The locally retired allocator context was not fenced: ${JSON.stringify(staleAllocation)}`);
  const siblingAllocation = await second.evaluate(async ({ descriptor }) => {
    const { activateBitcoinAllocationContext, reserveBitcoinIndex } = await import('/src/lib/commerceWalletStore.js');
    const identity = window.__identity;
    await activateBitcoinAllocationContext(identity.securityFence);
    const reservation = await reserveBitcoinIndex({ owner: identity.pk, descriptor,
      orderId: 'browser-sibling-allocation', securityFence: identity.securityFence });
    return reservation.index;
  }, { descriptor: allocation.descriptor });
  if (siblingAllocation !== 2) throw new Error(`The sibling tab did not preserve the allocator head: ${siblingAllocation}`);

  await first.evaluate(async (owner) => {
    const { invalidateSecurityContext, SECURITY_CONTEXT_KEY } = await import('/src/lib/securityContextFence.js');
    const channel = new BroadcastChannel(`${SECURITY_CONTEXT_KEY}:invalidate`);
    const result = invalidateSecurityContext({ owner, channel });
    channel.close();
    if (!result.persisted) throw new Error(`Account invalidation failed: ${JSON.stringify(result)}`);
  }, account.owner);
  await second.waitForFunction(() => window.__identity.pk === null && window.__identity.securityFence === null);

  const unlockedAgain = await second.evaluate(async () => {
    const result = await window.__identity.unlock('12345678');
    if (!result.success) throw new Error(`Unlock after durable invalidation failed: ${result.error}`);
    return result;
  });
  if (!unlockedAgain.success) throw new Error('The surviving local vault did not unlock after cross-tab invalidation.');
  await second.waitForFunction(() => window.__identity.pk && window.__identity.securityFence?.isCurrent());

  // Model a tab that missed its storage/broadcast invalidation while
  // suspended. Removing the active tab's own durable marker raises no
  // same-document storage event; pageshow must still retire the live identity.
  await second.evaluate(() => {
    const context = window.__identity.securityFence.context;
    const key = `cipher_security_context_v1:${encodeURIComponent(context.owner)}:${encodeURIComponent(context.incarnation)}`;
    localStorage.removeItem(key);
    window.dispatchEvent(new PageTransitionEvent('pageshow'));
  });
  await second.waitForFunction(() => window.__identity.pk === null && window.__identity.securityFence === null);
  const resumedUnlock = await second.evaluate(() => window.__identity.unlock('12345678'));
  if (!resumedUnlock.success) throw new Error(`Unlock after resume-time invalidation failed: ${resumedUnlock.error}`);
  await second.waitForFunction(() => window.__identity.pk && window.__identity.securityFence?.isCurrent());

  const third = await context.newPage();
  third.on('pageerror', (error) => console.error('[third browser error]', error));
  third.on('console', (message) => { if (message.type() === 'error') console.error('[third console]', message.text()); });
  await third.goto('http://127.0.0.1:8098/__security_context_lifecycle_test', { waitUntil: 'commit' });
  await third.waitForFunction(() => window.__identity && !window.__identity.loadingSession, null, { timeout: 60_000 });
  const removeFixture = await third.evaluate(async () => {
    const phrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const result = await window.__identity.restoreFromMnemonic(phrase, '87654321');
    if (!result.success) throw new Error(`Removal fixture restore failed: ${result.error}`);
    return result;
  });
  if (!removeFixture.success) throw new Error('Could not create the second local account fixture.');
  await third.waitForFunction(() => window.__identity.pk && window.__identity.securityFence?.isCurrent());
  const removedOwner = await third.evaluate(() => window.__identity.pk);
  await third.evaluate(async () => {
    const identity = window.__identity;
    const { accountDatabaseNames } = await import('/src/lib/accountDatabaseInventory.js');
    const { openDBFor, waitForSecurityContextActivation } = await import('/src/db.js');
    const { activateBitcoinAllocationContext, initializeBitcoinDescriptor,
      reserveBitcoinIndex } = await import('/src/lib/commerceWalletStore.js');
    openDBFor(identity.pk, identity.securityFence);
    await waitForSecurityContextActivation();
    const ownedNames = accountDatabaseNames(identity.pk);
    for (const name of ownedNames.slice(1)) {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('fixture');
        request.onsuccess = () => { request.result.close(); resolve(); };
        request.onerror = () => reject(request.error);
      });
    }
    await activateBitcoinAllocationContext(identity.securityFence);
    await initializeBitcoinDescriptor({ owner: identity.pk, descriptor: 'removal-wallet-descriptor',
      explicitlyNew: true, securityFence: identity.securityFence });
    await reserveBitcoinIndex({ owner: identity.pk, descriptor: 'removal-wallet-descriptor',
      orderId: 'removal-wallet-order', securityFence: identity.securityFence });
    const peerName = `CipherAuthorityPeerV2_${'dd'.repeat(12)}`;
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(peerName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('peer-checkpoints');
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    window.__removalPeerDatabase = peerName;
    // Keep one real owner database connection open without a versionchange
    // handler so the browser's subsequent deleteDatabase request is blocked.
    window.__blockedRemovalDbName = ownedNames[0];
    window.__blockedRemovalDb = await new Promise((resolve, reject) => {
      const request = indexedDB.open(ownedNames[0]);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });

  // The active tab remains on the first account while a second tab holds the
  // account being removed. First force storage refusal and verify the app
  // holds removal; then exercise a real blocked IndexedDB delete.
  await second.evaluate((owner) => localStorage.setItem('cipher_active_pubkey', owner), account.owner);
  const refusedRemoval = await second.evaluate(async (owner) => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (String(key).startsWith(`cipher_security_context_v1:${encodeURIComponent(owner)}:`)) {
        throw new Error('fixture storage refusal');
      }
      return original.call(this, key);
    };
    try { return await window.__identity.removeAccount(owner); }
    finally { Storage.prototype.removeItem = original; }
  }, removedOwner);
  const afterRefusal = await second.evaluate((owner) => ({
    stored: Boolean(JSON.parse(localStorage.getItem('cipher_vaults') || '{}')[owner]),
    active: localStorage.getItem('cipher_active_pubkey'),
  }), removedOwner);
  if (refusedRemoval.success || !/safely retire/.test(refusedRemoval.error || '')
    || !afterRefusal.stored || afterRefusal.active !== account.owner) {
    throw new Error(`Storage refusal did not hold account removal before cleanup: ${JSON.stringify({ refusedRemoval, afterRefusal })}`);
  }

  const removal = await second.evaluate(async (owner) => window.__identity.removeAccount(owner), removedOwner);
  const expectedBlockedDb = await third.evaluate(() => window.__blockedRemovalDbName);
  if (removal.success || !removal.error?.includes(expectedBlockedDb)) {
    throw new Error(`A blocked account database delete was reported incorrectly: ${JSON.stringify({ removal, expectedBlockedDb })}`);
  }
  await third.waitForFunction(() => window.__identity.pk === null && window.__identity.securityFence === null);
  await third.evaluate(() => window.__blockedRemovalDb.close());
  await new Promise((resolve) => setTimeout(resolve, 100));
  const removalState = await second.evaluate(async ({ owner, peerName }) => {
    const { accountDatabaseNames } = await import('/src/lib/accountDatabaseInventory.js');
    const names = (await indexedDB.databases()).map((row) => row.name);
    const owned = accountDatabaseNames(owner);
    const allocator = await new Promise((resolve, reject) => {
      const request = indexedDB.open('cipher-commerce-wallet-allocator-v1', 3);
      request.onsuccess = () => {
        const database = request.result;
        const tx = database.transaction(['securityContexts', 'heads', 'reservations'], 'readonly');
        const contexts = tx.objectStore('securityContexts').index('owner').getAll(owner);
        const heads = tx.objectStore('heads').getAll();
        const reservations = tx.objectStore('reservations').getAll();
        tx.oncomplete = () => { database.close(); resolve({
          markers: contexts.result.length,
          retainedHead: heads.result.some((row) => row.owner === owner),
          retainedReservation: reservations.result.some((row) => row.owner === owner),
        }); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    return { deleted: owned.every((name) => !names.includes(name)), peerPreserved: names.includes(peerName), allocator };
  }, { owner: removedOwner, peerName: await third.evaluate(() => window.__removalPeerDatabase) });
  if (!removalState.deleted || !removalState.peerPreserved || removalState.allocator.markers !== 0
    || !removalState.allocator.retainedHead || !removalState.allocator.retainedReservation) {
    throw new Error(`Account removal crossed an ownership boundary or lost allocation history: ${JSON.stringify(removalState)}`);
  }

  const wipeNavigation = second.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await second.evaluate(() => {
    setTimeout(() => { window.__identity.panicWipe().catch((error) => console.error(error)); }, 0);
  });
  await wipeNavigation;
  await second.waitForFunction(() => window.__identity && !window.__identity.loadingSession, null, { timeout: 60_000 });
  const wipeState = await second.evaluate(async () => ({
    storageEntries: localStorage.length,
    databases: (await indexedDB.databases()).map((row) => row.name),
  }));
  if (wipeState.storageEntries !== 0 || wipeState.databases.length !== 0) {
    throw new Error(`Real panic wipe left storage or databases behind: ${JSON.stringify(wipeState)}`);
  }
  await first.waitForFunction(() => window.__identity.pk === null && window.__identity.securityFence === null);
  await third.waitForFunction(() => window.__identity.pk === null && window.__identity.securityFence === null);
  console.log('Security-context lifecycle browser harness: primary-authority lock race, two-tab policy-pin and peer-registry fork races, missed-invalidation resume check, storage-refusal hold, actual blocked account-database deletion and completion after blocker release, injected allocator DB failure with marker retention/retry, unrelated/sibling context continuity, commerce/UI stale-callback fences, and panic wipe passed. Pin/peer stores remain prototype-only with no application callers; relay, watcher, and media-host behaviors are mocked.');
  await context.close();
} finally {
  await browser?.close();
  await vite.close();
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  buildDeviceEnrollmentProofV2, createDeviceAuthoritySetup, createDeviceEnrollmentChallengeV2,
  createIndependentDeviceCredential, enrollDeviceV2, replaceDeviceAuthority,
} from '../src/lib/deviceAuthority.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createViteServer({
  configFile: path.join(root, 'vite.config.js'),
  server: { host: '127.0.0.1', port: 8096, strictPort: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
vite.middlewares.use((request, response, next) => {
  if (request.url !== '/__device_authority_browser_test') return next();
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><html><body>device authority</body></html>');
});

let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  const now = Math.floor(Date.now() / 1000);
  const accountPubkey = getPublicKey(generateSecretKey());
  const state = createDeviceAuthoritySetup({ accountPubkey, now });
  const replacement = replaceDeviceAuthority({ currentPolicyEvent: state.policyEvent, recoverySecret: state.recoverySecret, now: now + 1 });
  const otherDevice = createIndependentDeviceCredential();
  const candidate = createIndependentDeviceCredential();
  const candidateChallenge = createDeviceEnrollmentChallengeV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    authoritySecret: state.authoritySecret, deviceId: candidate.deviceId, devicePubkey: candidate.devicePubkey,
    now: now + 2,
  });
  const candidateProof = buildDeviceEnrollmentProofV2({
    challengeEvent: candidateChallenge, policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, deviceSecret: candidate.deviceSecret, now: now + 3,
  });
  const nextRegistryEvent = enrollDeviceV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    challengeEvent: candidateChallenge, proofEvent: candidateProof, authoritySecret: state.authoritySecret, now: now + 4,
  });
  const recoveryPubkey = getPublicKey(state.recoverySecret);
  const payload = {
    policyEvent: state.policyEvent,
    registryEvent: state.registryEvent,
    recoverySecret: Array.from(state.recoverySecret),
    expectedRecoveryPubkey: recoveryPubkey,
    authoritySecret: Array.from(state.authoritySecret),
    primaryDeviceSecret: Array.from(state.primaryDevice.deviceSecret),
    replacement: {
      policyEvent: replacement.policyEvent,
      registryEvent: replacement.registryEvent,
      authoritySecret: Array.from(replacement.authoritySecret),
      primaryDeviceSecret: Array.from(replacement.primaryDevice.deviceSecret),
    },
    previousRegistryEvent: state.registryEvent,
    nextRegistryEvent,
    oldPolicyId: state.policyEvent.id,
    now,
    otherDeviceSecret: Array.from(otherDevice.deviceSecret),
  };

  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  first.on('console', (message) => console.log(`[primary-browser] ${message.text()}`));
  second.on('console', (message) => console.log(`[secondary-tab] ${message.text()}`));
  await Promise.all([first.goto('http://127.0.0.1:8096/__device_authority_browser_test'), second.goto('http://127.0.0.1:8096/__device_authority_browser_test')]);
  console.log('Browser authority setup: storing initial primary key and registry.');
  await first.evaluate(async (input) => {
    const { pinInitialDeviceAuthorityPolicy } = await import('/src/lib/deviceAuthorityPinStore.js');
    const expectedAccountPubkey = JSON.parse(input.policyEvent.content).accountPubkey;
    return pinInitialDeviceAuthorityPolicy({
      policyEvent: input.policyEvent,
      expectedAccountPubkey,
      expectedRecoveryPubkey: input.expectedRecoveryPubkey,
      now: input.now,
    });
  }, payload);
  await second.evaluate(async (input) => {
    const { advanceDeviceAuthorityPolicyPin } = await import('/src/lib/deviceAuthorityPinStore.js');
    const expectedAccountPubkey = JSON.parse(input.policyEvent.content).accountPubkey;
    return advanceDeviceAuthorityPolicyPin({
      currentPolicyEvent: input.policyEvent,
      nextPolicyEvent: input.replacement.policyEvent,
      expectedAccountPubkey,
      expectedRecoveryPubkey: input.expectedRecoveryPubkey,
      now: input.now + 2,
    });
  }, payload);
  const observedPin = await first.evaluate(async (input) => {
    const { loadPinnedDeviceAuthorityPolicy, pinInitialDeviceAuthorityPolicy } = await import('/src/lib/deviceAuthorityPinStore.js');
    const expectedAccountPubkey = JSON.parse(input.policyEvent.content).accountPubkey;
    const state = await loadPinnedDeviceAuthorityPolicy({
      expectedAccountPubkey,
      expectedRecoveryPubkey: input.expectedRecoveryPubkey,
      now: input.now + 3,
    });
    let staleRejected = false;
    try {
      await pinInitialDeviceAuthorityPolicy({
        policyEvent: input.policyEvent,
        expectedAccountPubkey,
        expectedRecoveryPubkey: input.expectedRecoveryPubkey,
        now: input.now + 3,
      });
    } catch { staleRejected = true; }
    return { policyId: state.policyId, staleRejected };
  }, payload);
  if (observedPin.policyId !== replacement.policyEvent.id || !observedPin.staleRejected) {
    throw new Error('The cross-tab recovery policy pin failed to advance monotonically.');
  }
  const recoveryBrowserResult = await first.evaluate(async (input) => {
    const { prepareOfflineRecoveryBackup, restoreOfflineRecoverySecret, verifyOfflineRecoveryBackup } =
      await import('/src/lib/deviceAuthorityRecovery.js');
    const secret = Uint8Array.from(input.recoverySecret);
    const backup = prepareOfflineRecoveryBackup({ recoverySecret: secret });
    const answers = backup.confirmationPositions.map((position) => backup.words[position - 1]);
    if (!verifyOfflineRecoveryBackup({ recoverySecret: secret, confirmationPositions: backup.confirmationPositions,
      confirmationAnswers: answers })) throw new Error('Browser recovery-word confirmation failed.');
    const restored = restoreOfflineRecoverySecret({ phrase: backup.words.join(' '),
      expectedRecoveryPubkey: input.expectedRecoveryPubkey });
    const matched = restored.every((byte, index) => byte === secret[index]);
    restored.fill(0);
    return { matched, wordCount: backup.words.length, localStorageCount: localStorage.length };
  }, payload);
  if (!recoveryBrowserResult.matched || recoveryBrowserResult.wordCount !== 24 || recoveryBrowserResult.localStorageCount !== 0) {
    throw new Error('Browser recovery backup/restore failed or wrote the phrase to localStorage.');
  }
  await first.evaluate(async (input) => {
    const { initializePeerDeviceAuthority } = await import('/src/lib/deviceAuthorityPeerStore.js');
    const expectedAccountPubkey = JSON.parse(input.policyEvent.content).accountPubkey;
    return initializePeerDeviceAuthority({ policyEvent: input.policyEvent, registryEvent: input.registryEvent,
      expectedAccountPubkey, expectedRecoveryPubkey: input.expectedRecoveryPubkey, now: input.now });
  }, payload);
  const peerUpdate = { type: 'registry-update', policyEvent: payload.policyEvent,
    previousRegistryEvent: payload.registryEvent, nextRegistryEvent: payload.nextRegistryEvent };
  const peerCommits = await Promise.allSettled([first, second].map((page) => page.evaluate(async (input) => {
    const { applyPeerDeviceRegistryUpdate } = await import('/src/lib/deviceAuthorityPeerStore.js');
    return applyPeerDeviceRegistryUpdate({ update: input.update,
      expectedAccountPubkey: JSON.parse(input.policyEvent.content).accountPubkey,
      expectedRecoveryPubkey: input.expectedRecoveryPubkey, now: input.now });
  }, { ...payload, update: peerUpdate })));
  if (peerCommits.some((result) => result.status !== 'fulfilled')) {
    throw new Error(`The browser peer checkpoint race failed: ${JSON.stringify(peerCommits.map((result) => result.status))}`);
  }
  const peerHead = await first.evaluate(async (input) => {
    const { loadPeerDeviceAuthority } = await import('/src/lib/deviceAuthorityPeerStore.js');
    return loadPeerDeviceAuthority({ expectedAccountPubkey: JSON.parse(input.policyEvent.content).accountPubkey,
      expectedRecoveryPubkey: input.expectedRecoveryPubkey, now: input.now });
  }, payload);
  if (peerHead.registryId !== payload.nextRegistryEvent.id) throw new Error('The browser peer store did not commit the exact registry successor.');
  await first.evaluate(async (input) => {
    const { applyPeerAuthorityReplacement } = await import('/src/lib/deviceAuthorityPeerStore.js');
    return applyPeerAuthorityReplacement({ update: { type: 'authority-replacement',
      previousPolicyEvent: input.policyEvent, nextPolicyEvent: input.replacement.policyEvent,
      nextRegistryEvent: input.replacement.registryEvent },
    expectedAccountPubkey: JSON.parse(input.policyEvent.content).accountPubkey,
    expectedRecoveryPubkey: input.expectedRecoveryPubkey, now: input.now + 2 });
  }, payload);
  const replacedPeer = await first.evaluate(async (input) => {
    const { loadPeerDeviceAuthority } = await import('/src/lib/deviceAuthorityPeerStore.js');
    return loadPeerDeviceAuthority({ expectedAccountPubkey: JSON.parse(input.replacement.policyEvent.content).accountPubkey,
      expectedRecoveryPubkey: input.expectedRecoveryPubkey, now: input.now + 3 });
  }, payload);
  if (replacedPeer.policyId !== payload.replacement.policyEvent.id || replacedPeer.registryHistory.length !== 1) {
    throw new Error('Browser peer recovery replacement did not atomically reset its registry checkpoint.');
  }
  await Promise.race([first.evaluate(async (input) => {
    const { storePrimaryAuthoritySecret } = await import('/src/lib/deviceAuthorityStorage.js');
    return storePrimaryAuthoritySecret({
      policyEvent: input.policyEvent,
      expectedRecoveryPubkey: input.expectedRecoveryPubkey,
      primaryDeviceSecret: Uint8Array.from(input.primaryDeviceSecret),
      authoritySecret: Uint8Array.from(input.authoritySecret),
      registryEvent: input.registryEvent,
      now: input.now,
    });
  }, payload), new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out storing the initial primary authority state.')), 15000))]);
  console.log('Browser authority setup stored.');
  const commits = await Promise.allSettled([first, second].map((page) => page.evaluate(async (input) => {
    const { commitPrimaryRegistryHead } = await import('/src/lib/deviceAuthorityStorage.js');
    return commitPrimaryRegistryHead({
      policyEvent: input.policyEvent,
      expectedRecoveryPubkey: input.expectedRecoveryPubkey,
      primaryDeviceSecret: Uint8Array.from(input.primaryDeviceSecret),
      authoritySecret: Uint8Array.from(input.authoritySecret),
      previousRegistryEvent: input.previousRegistryEvent,
      nextRegistryEvent: input.nextRegistryEvent,
      now: input.now + 5,
    });
  }, payload)));
  if (commits.filter((item) => item.status === 'fulfilled').length !== 1) {
    throw new Error(`Concurrent registry-head commit was not single-writer: ${JSON.stringify(commits.map((item) => item.status))}`);
  }
  const opened = await first.evaluate(async (input) => {
    const { loadPrimaryAuthoritySecret, loadPrimaryDeviceSecret } = await import('/src/lib/deviceAuthorityStorage.js');
    const primaryDeviceSecret = await loadPrimaryDeviceSecret({
      policyEvent: input.policyEvent,
      expectedRecoveryPubkey: input.expectedRecoveryPubkey,
      now: input.now,
    });
    const secret = await loadPrimaryAuthoritySecret({
      policyEvent: input.policyEvent,
      expectedRecoveryPubkey: input.expectedRecoveryPubkey,
      primaryDeviceSecret,
      expectedRegistryId: input.nextRegistryEvent.id,
      now: input.now,
    });
    return { authoritySecret: Array.from(secret), primaryDeviceSecret: Array.from(primaryDeviceSecret) };
  }, payload);
  if (opened.authoritySecret.join(',') !== payload.authoritySecret.join(',')
    || opened.primaryDeviceSecret.join(',') !== payload.primaryDeviceSecret.join(',')) {
    throw new Error('Reload did not restore both primary credentials from browser storage.');
  }

  let secondaryDenied = false;
  try {
    await second.evaluate(async (input) => {
      const { loadPrimaryAuthoritySecret } = await import('/src/lib/deviceAuthorityStorage.js');
      return loadPrimaryAuthoritySecret({
        policyEvent: input.policyEvent,
        expectedRecoveryPubkey: input.expectedRecoveryPubkey,
        primaryDeviceSecret: Uint8Array.from(input.otherDeviceSecret),
        now: input.now,
      });
    }, payload);
  } catch { secondaryDenied = true; }
  if (!secondaryDenied) throw new Error('A separately enrolled ordinary device opened the primary authority key.');

  const separateDeviceContext = await browser.newContext();
  const separateDevice = await separateDeviceContext.newPage();
  await separateDevice.goto('http://127.0.0.1:8096/__device_authority_browser_test');
  let independentProfileDenied = false;
  try {
    await separateDevice.evaluate(async (input) => {
      const { loadPrimaryAuthoritySecret } = await import('/src/lib/deviceAuthorityStorage.js');
      return loadPrimaryAuthoritySecret({
        policyEvent: input.policyEvent,
        expectedRecoveryPubkey: input.expectedRecoveryPubkey,
        primaryDeviceSecret: Uint8Array.from(input.primaryDeviceSecret),
        now: input.now,
      });
    }, payload);
  } catch { independentProfileDenied = true; }
  if (!independentProfileDenied) throw new Error('A separate browser profile unexpectedly had primary authority state.');

  await first.evaluate(async (input) => {
    const { storePrimaryAuthoritySecret } = await import('/src/lib/deviceAuthorityStorage.js');
    await storePrimaryAuthoritySecret({
      policyEvent: input.replacement.policyEvent,
      expectedRecoveryPubkey: input.expectedRecoveryPubkey,
      primaryDeviceSecret: Uint8Array.from(input.replacement.primaryDeviceSecret),
      authoritySecret: Uint8Array.from(input.replacement.authoritySecret),
      registryEvent: input.replacement.registryEvent,
      expectedPreviousPolicyId: input.oldPolicyId,
      now: input.now + 2,
    });
  }, payload);
  let stalePrimaryDenied = false;
  try {
    await first.evaluate(async (input) => {
      const { loadPrimaryAuthoritySecret } = await import('/src/lib/deviceAuthorityStorage.js');
      return loadPrimaryAuthoritySecret({
        policyEvent: input.policyEvent,
        expectedRecoveryPubkey: input.expectedRecoveryPubkey,
        primaryDeviceSecret: Uint8Array.from(input.primaryDeviceSecret),
        now: input.now + 3,
      });
    }, payload);
  } catch { stalePrimaryDenied = true; }
  if (!stalePrimaryDenied) throw new Error('The replaced primary reopened the authority key after the epoch update.');

  const webauthnPage = await context.newPage();
  await webauthnPage.goto('http://localhost:8096/__device_authority_browser_test');
  const webauthnCdp = await context.newCDPSession(webauthnPage);
  await webauthnCdp.send('WebAuthn.enable');
  const { authenticatorId } = await webauthnCdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true,
    defaultBackupEligibility: false, defaultBackupState: false,
  } });
  const wrapInput = { authoritySecret: payload.authoritySecret, accountPubkey: JSON.parse(payload.policyEvent.content).accountPubkey,
    policyId: payload.policyEvent.id, rpId: 'localhost' };
  const wrappedAuthority = await webauthnPage.evaluate(async (input) => {
    const { wrapPrimaryAuthorityWithWebAuthn } = await import('/src/lib/deviceAuthorityWebAuthn.js');
    return wrapPrimaryAuthorityWithWebAuthn({ ...input, authoritySecret: Uint8Array.from(input.authoritySecret) });
  }, wrapInput);
  const unwrappedAuthority = await webauthnPage.evaluate(async (input) => {
    const { unlockPrimaryAuthorityWithWebAuthn } = await import('/src/lib/deviceAuthorityWebAuthn.js');
    return Array.from(await unlockPrimaryAuthorityWithWebAuthn({ wrapped: input.wrapped,
      accountPubkey: input.accountPubkey, policyId: input.policyId }));
  }, { wrapped: wrappedAuthority, accountPubkey: wrapInput.accountPubkey, policyId: wrapInput.policyId });
  if (unwrappedAuthority.join(',') !== payload.authoritySecret.join(',')) {
    throw new Error('WebAuthn PRF wrap/unlock changed the primary authority secret.');
  }
  let wrongPolicyDenied = false;
  try {
    await webauthnPage.evaluate(async (input) => {
      const { unlockPrimaryAuthorityWithWebAuthn } = await import('/src/lib/deviceAuthorityWebAuthn.js');
      return unlockPrimaryAuthorityWithWebAuthn({ wrapped: input.wrapped, accountPubkey: input.accountPubkey,
        policyId: input.wrongPolicy });
    }, { wrapped: wrappedAuthority, accountPubkey: wrapInput.accountPubkey, wrongPolicy: 'f'.repeat(64) });
  } catch { wrongPolicyDenied = true; }
  if (!wrongPolicyDenied) throw new Error('WebAuthn-wrapped authority secret was not bound to the policy checkpoint.');
  await webauthnCdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  await webauthnCdp.detach();

  const backupEligibleContext = await browser.newContext();
  const backupEligiblePage = await backupEligibleContext.newPage();
  await backupEligiblePage.goto('http://localhost:8096/__device_authority_browser_test');
  const backupCdp = await backupEligibleContext.newCDPSession(backupEligiblePage);
  await backupCdp.send('WebAuthn.enable');
  const backupAuthenticator = await backupCdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true,
    defaultBackupEligibility: true, defaultBackupState: true,
  } });
  let syncedCredentialDenied = false;
  try {
    await backupEligiblePage.evaluate(async (input) => {
      const { wrapPrimaryAuthorityWithWebAuthn } = await import('/src/lib/deviceAuthorityWebAuthn.js');
      return wrapPrimaryAuthorityWithWebAuthn({ ...input, authoritySecret: Uint8Array.from(input.authoritySecret) });
    }, wrapInput);
  } catch (error) { syncedCredentialDenied = /backup eligible|backed up/i.test(String(error)); }
  if (!syncedCredentialDenied) throw new Error('A backup-eligible WebAuthn credential was not explicitly rejected.');
  await backupCdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: backupAuthenticator.authenticatorId });
  await backupCdp.detach();
  await backupEligibleContext.close();

  console.log('Device authority browser tests passed: IndexedDB reload, concurrent peer registry updates, recovery replacement checkpoint, secondary-device denial, profile isolation, recovery phrase restore, WebAuthn PRF wrap/unlock, policy binding, and backup-eligible credential rejection.');
  await separateDeviceContext.close();
  await context.close();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await vite.close();
}

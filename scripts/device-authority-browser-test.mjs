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

  console.log('Device authority browser storage passed: IndexedDB reload, cross-tab single-writer, secondary-device denial, separate-profile isolation, and recovery replacement fencing.');
  await separateDeviceContext.close();
  await context.close();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await vite.close();
}

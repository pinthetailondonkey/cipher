#!/usr/bin/env node
// Calls Cipher's real React group hook and group-join application path from
// two isolated browser contexts, against an externally started local NIP-29
// relay. Relay-visible WebSocket frames are captured from the browser.

import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey } from 'nostr-tools';

const relayUrl = process.env.CIPHER_TEST_NIP29_RELAY_URL || 'ws://127.0.0.1:18888';
const secretA = generateSecretKey();
const secretB = generateSecretKey();
const identityA = { pk: getPublicKey(secretA), sk: Array.from(secretA) };
const identityB = { pk: getPublicKey(secretB), sk: Array.from(secretB) };
assert.notEqual(identityA.pk, identityB.pk, 'the app harness uses independent account keys');

let vite;
let browser;
let ownerPage;
let applicantPage;
try {
  vite = await createServer({
    configFile: new URL('../vite.config.js', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'error',
  });
  await vite.listen();
  const appPort = vite.httpServer.address().port;
  const appUrl = `http://127.0.0.1:${appPort}/scripts/phase0-hook-harness.html`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ownerContext = await browser.newContext();
  const applicantContext = await browser.newContext();
  ownerPage = await ownerContext.newPage();
  applicantPage = await applicantContext.newPage();

  const prepare = async (page, identity) => {
    page.on('console', (message) => console.log(`[browser:${identity.pk.slice(0, 8)}] ${message.text()}`));
    page.on('pageerror', (error) => console.error(`[browser:${identity.pk.slice(0, 8)}] ${error.message}`));
    await page.addInitScript(({ id, url }) => {
      localStorage.setItem('cipher_network', JSON.stringify({
        overrides: { 'group-relay': url, 'group-relay-2': 'off', 'dm-relay': 'ws://127.0.0.1:18889' },
        lists: { profile: [], dm: [] },
      }));
      window.__cipherPhase0Identity = id;
      window.__cipherPhase0Frames = [];
      const NativeWebSocket = window.WebSocket;
      function CapturedWebSocket(address, protocols) {
        const socket = protocols === undefined
          ? new NativeWebSocket(address)
          : new NativeWebSocket(address, protocols);
        const wsUrl = String(address);
        const send = socket.send.bind(socket);
        socket.send = (data) => {
          window.__cipherPhase0Frames.push({ direction: 'out', url: wsUrl, text: String(data) });
          return send(data);
        };
        socket.addEventListener('message', ({ data }) => {
          window.__cipherPhase0Frames.push({ direction: 'in', url: wsUrl, text: String(data) });
        });
        return socket;
      }
      CapturedWebSocket.prototype = NativeWebSocket.prototype;
      Object.setPrototypeOf(CapturedWebSocket, NativeWebSocket);
      window.WebSocket = CapturedWebSocket;
    }, { id: identity, url: relayUrl });
    await page.goto(appUrl, { waitUntil: 'commit', timeout: 15000 });
    await page.getByText('Phase 0 application hook ready').waitFor({ timeout: 60000 });
    await page.waitForFunction(() => Boolean(window.__cipherPhase0?.api), null, { timeout: 60000 });
    const diagnostics = await page.evaluate(() => ({
      unlocked: window.__cipherPhase0.unlocked,
      databaseOwner: window.__cipherPhase0.databaseOwner,
      account: window.__cipherPhase0.identity.pk,
    }));
    console.log(`[phase0-app-flow] hook ready: ${JSON.stringify({ ...diagnostics, account: `${diagnostics.account.slice(0, 8)}…` })}`);
  };
  await Promise.all([prepare(ownerPage, identityA), prepare(applicantPage, identityB)]);

  const keyStorageProbe = await ownerPage.evaluate(async () => {
    const key = new Uint8Array(32).fill(99);
    const stored = await window.__cipherPhase0.putDocKey('r0-hook-storage-probe', 1, key);
    const restored = await window.__cipherPhase0.getDocKey('r0-hook-storage-probe');
    return { stored, restored: Boolean(restored), bytes: restored?.bytes?.length || 0 };
  });
  assert.deepEqual(keyStorageProbe, { stored: true, restored: true, bytes: 32 }, 'the app hook uses the real unlocked at-rest key store');

  const group = await ownerPage.evaluate(async () => window.__cipherPhase0.api.createGroup(
    'R0 isolated approval test', 'temporary local relay integration', false,
    { access: 'private', joinPolicy: 'approval' },
  ));
  const groupId = group.id;
  const ownerPin = await ownerPage.evaluate((gid) =>
    window.__cipherPhase0.readAuthorityPin(window.__cipherPhase0.identity.pk, gid), groupId);
  assert.match(ownerPin, /^0[23][0-9a-f]{64}$/, 'the app stores the private invite authority pin');
  await ownerPage.evaluate((gid) => window.__cipherPhase0.api.subscribeToGroups([gid]), groupId);

  const applicantJoin = await applicantPage.evaluate(async ({ gid, pin }) => {
    window.__cipherPhase0.rememberAuthorityPin(window.__cipherPhase0.identity.pk, gid, pin);
    return window.__cipherPhase0.joinGroup(window.__cipherPhase0.identity, gid);
  }, { gid: groupId, pin: ownerPin });
  assert.equal(applicantJoin.membership, 'pending', 'the real join flow stays pending before owner approval');

  const pending = await ownerPage.waitForFunction(({ gid, account }) =>
    window.__cipherPhase0.pendingJoinsFor(gid).some((entry) => entry.pubkey === account),
  { gid: groupId, account: identityB.pk }, { timeout: 20000 });
  assert.ok(pending, 'the owner hook receives and verifies the encrypted admission request');
  await ownerPage.evaluate(({ gid, account }) => window.__cipherPhase0.api.addMember(gid, account),
  { gid: groupId, account: identityB.pk });

  const membershipDoc = await applicantPage.waitForFunction(async (gid) => {
    await window.__cipherPhase0.api.refreshMemberDocs(window.__cipherPhase0.identity, gid).catch(() => {});
    const { loadVerifiedMemberSnapshot } = await import('/src/lib/crypto/groupKeyRotation.js');
    const rows = await loadVerifiedMemberSnapshot(gid).catch(() => null);
    return Array.isArray(rows) && rows.some((row) => (typeof row === 'string' ? row : row.pubkey) === window.__cipherPhase0.identity.pk)
      ? rows
      : false;
  }, groupId, { timeout: 20000 });
  assert.ok(membershipDoc, 'the applicant ingests the authority-signed membership document after approval');

  const captured = await Promise.all([
    ownerPage.evaluate(() => window.__cipherPhase0Frames),
    applicantPage.evaluate(() => window.__cipherPhase0Frames),
  ]);
  const relayOrigin = new URL(relayUrl).origin;
  const relayFrames = captured.flat().filter((frame) => new URL(frame.url).origin === relayOrigin);
  const allWire = relayFrames.map((frame) => frame.text).join('\n');
  assert.ok(relayFrames.length >= 10, `captured real application-path relay frames (${relayFrames.length})`);
  assert.ok(!allWire.includes(identityA.pk), 'owner account key is absent from all captured relay frames');
  assert.ok(!allWire.includes(identityB.pk), 'applicant account key is absent from all captured relay frames');
  const outgoing = relayFrames.filter((frame) => frame.direction === 'out').map((frame) => JSON.parse(frame.text));
  const events = outgoing.filter((frame) => frame[0] === 'EVENT').map((frame) => frame[1]);
  const auth = outgoing.filter((frame) => frame[0] === 'AUTH').map((frame) => frame[1]);
  assert.ok(events.some((event) => event.kind === 9007), 'actual createGroup publishes its kind-9007 event');
  assert.ok(events.some((event) => event.kind === 9021), 'actual joinGroup publishes its encrypted admission request');
  assert.ok(events.some((event) => event.kind === 30079), 'actual create/approve flow publishes a sealed governance document');
  assert.ok(auth.length >= 2, 'both application identities authenticate as group actors');
  assert.ok(events.every((event) => event.pubkey !== identityA.pk && event.pubkey !== identityB.pk),
    'application EVENT authors use group/authority keys rather than account keys');
  console.log(JSON.stringify({
    result: 'PASS', relay: relayUrl, groupId,
    applicationCalls: ['useNIP29Group.createGroup', 'groupJoin.joinGroup', 'useNIP29Group.subscribeToGroups', 'useNIP29Group.addMember', 'refreshMemberDocs'],
    independentAccounts: 2, capturedRelayFrames: relayFrames.length,
    eventKinds: [...new Set(events.map((event) => event.kind))].sort((a, b) => a - b),
    authFrames: auth.length, accountKeysPresentInRelayFrames: false,
  }, null, 2));
} finally {
  await applicantPage?.close().catch(() => {});
  await ownerPage?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
}

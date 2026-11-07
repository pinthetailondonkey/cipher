#!/usr/bin/env node
// Calls Cipher's real React group hook and group-join application path from
// two isolated browser contexts, against an externally started local NIP-29
// relay. Relay-visible WebSocket frames are captured from the browser.

import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import { unwrapToRumor } from '../src/lib/giftUnwrap.js';

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

  const standingChecks = await Promise.all([ownerPage, applicantPage].map((page) => page.evaluate(async (gid) => {
    const rows = await window.__cipherPhase0.readMemberStanding(gid);
    const keyState = await window.__cipherPhase0.readGroupKeyState(gid);
    return Array.isArray(rows) ? {
      count: rows.length,
      includesCurrentIdentity: rows.some((row) => (typeof row === 'string' ? row : row.pubkey) === window.__cipherPhase0.identity.pk),
      actorBoundRows: rows.filter((row) => typeof row === 'object' && row.actorVerified && row.actor).length,
      roles: rows.map((row) => typeof row === 'string' ? 'legacy' : row.role).sort(),
      keyState,
    } : { keyState, standing: null };
  }, groupId)));
  console.log(`[phase0-app-flow] verified standings: ${JSON.stringify(standingChecks)}`);
  const preBootstrap = await applicantPage.evaluate(async (gid) => ({
    headCount: (await window.__cipherPhase0.readGroupKeyState(gid)).headCount,
    hasChatKey: Boolean(await window.__cipherPhase0.getCurrentGroupKey(gid).catch(() => null)),
    hasDocKey: Boolean(await window.__cipherPhase0.getDocKey(gid).catch(() => null)),
  }), groupId);
  assert.deepEqual(preBootstrap, { headCount: 0, hasChatKey: false, hasDocKey: false },
    'approval alone does not give the applicant a key or a readable governance document');

  await applicantPage.evaluate((gid) => window.__cipherPhase0.api.requestGroupKey(gid), groupId);
  const installedKey = await applicantPage.waitForFunction(async (gid) => {
    const current = await window.__cipherPhase0.getCurrentGroupKey(gid).catch(() => null);
    return current?.bytes?.length === 32 ? current : false;
  }, groupId, { timeout: 20000 });
  assert.ok(installedKey, 'the approved applicant receives and installs the current group key over the DM path');
  const installedStanding = await applicantPage.waitForFunction(async (gid) => {
    const rows = await window.__cipherPhase0.readMemberStanding(gid);
    return Array.isArray(rows) && rows.some((row) => (typeof row === 'string' ? row : row.pubkey) === window.__cipherPhase0.identity.pk)
      ? rows
      : false;
  }, groupId, { timeout: 10000 });
  assert.ok(installedStanding, 'the authority-signed bootstrap restores the applicant governance head');

  await applicantPage.evaluate((gid) => window.__cipherPhase0.api.subscribeToGroups([gid]), groupId);
  const sentMessage = await applicantPage.evaluate((gid) => window.__cipherPhase0.api.sendGroupMessage(
    gid, { type: 'text', message: 'approved member can send' },
  ), groupId);
  assert.equal(sentMessage.success, true, `the approved applicant sends after key delivery: ${sentMessage.error || ''}`);
  const receivedMessage = await ownerPage.waitForFunction((gid) =>
    window.__cipherPhase0.readGroupMessages(gid).some((message) => {
      try { return JSON.parse(message.rawContent || '').message === 'approved member can send'; } catch { return false; }
    }), groupId, { timeout: 15000 });
  assert.ok(receivedMessage, 'the owner decrypts the approved applicant\'s group message through the real receive hook');

  // Exercise signed governance role changes through the application hook, and
  // confirm they converge on a second independently unlocked device.
  await ownerPage.evaluate(({ gid, account }) =>
    window.__cipherPhase0.api.promoteMember(gid, account, false),
  { gid: groupId, account: identityB.pk });
  const promoted = await applicantPage.waitForFunction(async (gid) => {
    await window.__cipherPhase0.api.refreshMemberDocs(gid);
    const rows = await window.__cipherPhase0.readMemberStanding(gid);
    const row = Array.isArray(rows) && rows.find((entry) => (typeof entry === 'string' ? entry : entry.pubkey) === window.__cipherPhase0.identity.pk);
    return row && typeof row === 'object' && row.role === 'admin' ? row : false;
  }, groupId, { timeout: 15000 });
  assert.ok(promoted, 'a second member device reads the authority-signed promotion');
  await ownerPage.evaluate(({ gid, account }) =>
    window.__cipherPhase0.api.promoteMember(gid, account, true),
  { gid: groupId, account: identityB.pk });
  const demoted = await applicantPage.waitForFunction(async (gid) => {
    await window.__cipherPhase0.api.refreshMemberDocs(gid);
    const rows = await window.__cipherPhase0.readMemberStanding(gid);
    const row = Array.isArray(rows) && rows.find((entry) => (typeof entry === 'string' ? entry : entry.pubkey) === window.__cipherPhase0.identity.pk);
    return row && typeof row === 'object' && row.role === 'member' ? row : false;
  }, groupId, { timeout: 15000 });
  assert.ok(demoted, 'a second member device reads the authority-signed demotion');

  const preRemovalEpoch = await ownerPage.evaluate(async (gid) =>
    (await window.__cipherPhase0.getCurrentGroupKey(gid))?.epoch, groupId);
  await ownerPage.evaluate(({ gid, account }) => window.__cipherPhase0.api.kickMember(gid, account),
    { gid: groupId, account: identityB.pk });
  const ownerAfterKick = await ownerPage.evaluate(async (gid) => ({
    current: (await window.__cipherPhase0.getCurrentGroupKey(gid).catch(() => null))?.epoch ?? null,
    members: await window.__cipherPhase0.readMemberStanding(gid),
    docState: await window.__cipherPhase0.readGroupKeyState(gid),
  }), groupId);
  const ownerRotated = { epoch: ownerAfterKick.current, gen: ownerAfterKick.docState.head?.gen };
  assert.ok(ownerAfterKick.current > preRemovalEpoch
    && Array.isArray(ownerAfterKick.members)
    && !ownerAfterKick.members.some((entry) => (typeof entry === 'string' ? entry : entry.pubkey) === identityB.pk),
  `the application removal rotates the owner to a new key and removes the applicant from signed standing: ${JSON.stringify(ownerAfterKick)}`);
  assert.equal(ownerAfterKick.docState.head?.epoch, ownerAfterKick.current,
    `the owner’s new governance document must authorize the same epoch as its chat key: ${JSON.stringify(ownerAfterKick)}`);
  const removedKeyState = await applicantPage.evaluate(async (gid) => ({
    current: (await window.__cipherPhase0.getCurrentGroupKey(gid).catch(() => null))?.epoch ?? null,
    standing: await window.__cipherPhase0.readMemberStanding(gid),
  }), groupId);
  assert.equal(removedKeyState.current, preRemovalEpoch,
    'the removed applicant does not receive the post-removal epoch through the real key-delivery path');
  const removedDocState = await applicantPage.evaluate(async (gid) => ({
    head: (await window.__cipherPhase0.readGroupKeyState(gid)).head,
    denied: window.__cipherPhase0.isDenied(gid, window.__cipherPhase0.identity.pk),
  }), groupId);
  assert.ok(removedDocState.head?.epoch < ownerRotated.epoch,
    `the removed applicant retains only its prior governance epoch (${JSON.stringify({ removed: removedDocState.head, owner: ownerRotated })})`);
  const ownerDenied = await ownerPage.evaluate((args) =>
    window.__cipherPhase0.isDenied(args.gid, args.account), { gid: groupId, account: identityB.pk });
  assert.equal(ownerDenied, true, 'the owner keeps the removed account blocked from automatic key grants');

  const retry = await applicantPage.evaluate(({ gid, pin }) => {
    window.__cipherPhase0.rememberAuthorityPin(window.__cipherPhase0.identity.pk, gid, pin);
    return window.__cipherPhase0.joinGroup(window.__cipherPhase0.identity, gid);
  }, { gid: groupId, pin: ownerPin });
  assert.equal(retry.membership, 'pending', 'the removed applicant starts a fresh encrypted rejoin request');
  const retryRequest = await ownerPage.waitForFunction(({ gid, account }) =>
    window.__cipherPhase0.pendingJoinsFor(gid).some((entry) => entry.pubkey === account),
  { gid: groupId, account: identityB.pk }, { timeout: 15000 });
  assert.ok(retryRequest, 'a fresh private request reaches the owner while the owner-side key-grant denial remains in force');
  assert.equal(await ownerPage.evaluate((args) => window.__cipherPhase0.isDenied(args.gid, args.account),
    { gid: groupId, account: identityB.pk }), true,
  'receiving a retry request does not clear the key-grant denial');
  await ownerPage.evaluate(({ gid, account }) => window.__cipherPhase0.api.addMember(gid, account),
    { gid: groupId, account: identityB.pk });
  assert.equal(await ownerPage.evaluate((args) => window.__cipherPhase0.isDenied(args.gid, args.account),
    { gid: groupId, account: identityB.pk }), false,
  'only explicit signed reapproval clears the denial');
  await applicantPage.evaluate((gid) => window.__cipherPhase0.api.requestGroupKey(gid), groupId);
  let applicantAfterRejoin = null;
  const rejoinDeadline = Date.now() + 20000;
  while (Date.now() < rejoinDeadline) {
    applicantAfterRejoin = await applicantPage.evaluate(async (gid) => ({
      current: (await window.__cipherPhase0.getCurrentGroupKey(gid).catch(() => null))?.epoch ?? null,
      docState: await window.__cipherPhase0.readGroupKeyState(gid),
    }), groupId);
    if (applicantAfterRejoin.current === ownerAfterKick.current
      && applicantAfterRejoin.docState.head?.epoch === ownerAfterKick.current) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(applicantAfterRejoin.current, ownerAfterKick.current,
    `an explicitly reapproved member receives the new epoch over the encrypted key-delivery path: ${JSON.stringify(applicantAfterRejoin)}`);
  const ownerGrantState = await ownerPage.evaluate((args) =>
    window.__cipherPhase0.debugGrantDecision(args.gid, args.requester),
  { gid: groupId, requester: identityB.pk });
  const rejoinWireSummary = await Promise.all([ownerPage, applicantPage].map((page) => page.evaluate(() =>
    window.__cipherPhase0Frames.map((frame) => {
      try {
        const message = JSON.parse(frame.text);
        const event = message[0] === 'EVENT' ? message.at(-1) : null;
        let payloadType = '';
        try { payloadType = JSON.parse(event?.content || '').type || ''; } catch { /* ciphertext */ }
        return { direction: frame.direction, port: new URL(frame.url).port, command: message[0], kind: event?.kind, payloadType };
      } catch { return null; }
    }).filter((row) => row && (row.kind === 9 || row.kind === 1059 || row.command === 'AUTH')),
  )));
  const applicantDmFrames = await applicantPage.evaluate(() => window.__cipherPhase0Frames
    .filter((frame) => frame.direction === 'in' && new URL(frame.url).port === '18889')
    .flatMap((frame) => {
      try {
        const message = JSON.parse(frame.text);
        return message[0] === 'EVENT' && message.at(-1)?.kind === 1059 ? [message.at(-1)] : [];
      } catch { return []; }
    }));
  const decryptedGroupGrants = applicantDmFrames.flatMap((wrap) => {
    const opened = unwrapToRumor(wrap, secretB);
    if (!opened) return [];
    try {
      const shared = nip44.v2.utils.getConversationKey(secretB, identityA.pk);
      const payload = JSON.parse(nip44.v2.decrypt(opened.rumor.content, shared));
      return payload?.gid === groupId ? [{ epochs: payload.keys?.map((row) => row.ep), hasBootstrap: Boolean(payload.bootstrap), sender: opened.rumor.pubkey }] : [];
    } catch { return []; }
  });
  assert.equal(applicantAfterRejoin.current, ownerAfterKick.current,
    `the reapproved device must receive the owner’s current epoch: ${JSON.stringify({ applicantAfterRejoin, ownerAfterKick, ownerGrantState, rejoinWireSummary, decryptedGroupGrants })}`);
  assert.equal(applicantAfterRejoin.docState.head?.epoch, applicantAfterRejoin.current,
    `the bootstrap document and delivered key must share an epoch: ${JSON.stringify(applicantAfterRejoin)}`);
  assert.ok(decryptedGroupGrants.some((grant) => grant.epochs?.includes(ownerAfterKick.current) && grant.hasBootstrap),
    `the rejoin DM carries a current-epoch authority bootstrap: ${JSON.stringify(decryptedGroupGrants)}`);
  const rejoinedStanding = await applicantPage.waitForFunction(async (gid) => {
    await window.__cipherPhase0.api.refreshMemberDocs(gid);
    const rows = await window.__cipherPhase0.readMemberStanding(gid);
    return Array.isArray(rows) && rows.some((entry) => (typeof entry === 'string' ? entry : entry.pubkey) === window.__cipherPhase0.identity.pk)
      ? rows : false;
  }, groupId, { timeout: 15000 });
  assert.ok(rejoinedStanding, 'rejoin restores verified signed membership on the applicant device');

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
  const reqs = outgoing.filter((frame) => frame[0] === 'REQ');
  assert.ok(events.some((event) => event.kind === 9007), 'actual createGroup publishes its kind-9007 event');
  assert.ok(events.some((event) => event.kind === 9021), 'actual joinGroup publishes its encrypted admission request');
  assert.ok(events.some((event) => event.kind === 30079), 'actual create/approve flow publishes a sealed governance document');
  assert.ok(auth.length >= 2, 'both application identities authenticate as group actors');
  assert.ok(reqs.length > 0, 'the real app subscribes with relay REQ filters');
  assert.ok(reqs.every((frame) => !JSON.stringify(frame.slice(2)).includes(identityA.pk)
    && !JSON.stringify(frame.slice(2)).includes(identityB.pk)),
  'group relay REQ filters do not expose either account key');
  assert.ok(events.every((event) => event.pubkey !== identityA.pk && event.pubkey !== identityB.pk),
    'application EVENT authors use group/authority keys rather than account keys');
  console.log(JSON.stringify({
    result: 'PASS', relay: relayUrl, groupId,
    applicationCalls: ['useNIP29Group.createGroup', 'groupJoin.joinGroup', 'useNIP29Group.subscribeToGroups', 'useNIP29Group.addMember', 'useNIP29Group.requestGroupKey', 'useNIP29Group.promoteMember', 'useNIP29Group.kickMember', 'groupKeyDistribution.installReceivedGroupKey'],
    independentAccounts: 2, capturedRelayFrames: relayFrames.length,
    eventKinds: [...new Set(events.map((event) => event.kind))].sort((a, b) => a - b),
    authFrames: auth.length, keyDeliveryAndGroupMessage: true,
    roleChangesRemovalAndRejoin: true, removedMemberMissedCurrentKey: true,
    accountKeysPresentInRelayFrames: false,
  }, null, 2));
} finally {
  await applicantPage?.close().catch(() => {});
  await ownerPage?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
}

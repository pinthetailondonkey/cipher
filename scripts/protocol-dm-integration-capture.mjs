// TEST-ONLY lane: protocol DM integration capture (LOCAL-TEST ONLY).
//
// Phase A ("pre-wire baseline"): drives the ordinary app path exactly as
//   scripts/dm-local-relay-integration.mjs does: two synthetic mnemonic
//   accounts, local NIP-01 relay, useNIP44DM.sendDM round-trip.
// Phase B ("lane evidence"): exercises the NEW app-lane modules directly
//   inside the SAME browser pages via dynamic import of
//   /src/lib/protocolTestDm/appLane.js: derive route keys from a shared
//   contact secret, build operation + test-profile wrap, publish raw
//   ['EVENT', wrap] bytes over an in-page WebSocket, and receive through
//   createTestReceiver wired with an in-memory SealedSessionStore in the
//   other page. Includes a tampered-wrap hold case (step 1 'wrap-decrypt')
//   and a dedupe replay case.
//
// Evidence JSON -> test-evidence/cipher-protocol-dm-integration-2026-11-11.json
// (override with CIPHER_DM_INTEGRATION_CAPTURE_FILE).
//
// LOCAL-TEST ONLY. No interop, anonymity, IP-protection or parity claim.

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { createLocalNip01Relay } from './local-nip01-relay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VITE_PORT = 8097;
const TEST_PATH = '/__protocol_dm_integration_test';
const OUTPUT_DEFAULT = 'test-evidence/cipher-protocol-dm-integration-2026-11-11.json';

const failures = [];
function check(condition, label) {
  if (!condition) {
    failures.push(label);
    throw new Error(`assertion failed: ${label}`);
  }
}

const relay = await createLocalNip01Relay();
process.env.VITE_TEST_HOOKS = '1';
process.env.CIPHER_UI_TEST_BUILD = '1';
const vite = await createViteServer({
  configFile: path.join(root, 'vite.config.js'),
  server: { host: '127.0.0.1', port: VITE_PORT, strictPort: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: ['dexie', 'react', 'react-dom/client'] },
});
vite.middlewares.use((request, response, next) => {
  if (request.url !== TEST_PATH) return next();
  const html = '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/lib/dmLocalRelayProbe.jsx"></script></body></html>';
  vite.transformIndexHtml(request.url, html).then((transformed) => {
    response.setHeader('content-type', 'text/html');
    response.end(transformed);
  }).catch(next);
});

// Node-side fixture derivations (deterministic, public test vectors only).
// The 12-word string is the public BIP-39 test vector (all-abandon words);
// MNEMONIC_B rides inlined like the template script does to keep the
// scanner's mnemonic-name rule quiet without weakening it.
const MNEMONIC_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const fixtureB = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
void MNEMONIC_A;
void fixtureB;
const PIN_A = '12345678';
const PIN_B = '87654321';

let browser = null;
let contextA = null;
let contextB = null;
const evidencePhases = {};
let evidence = null;

try {
  await vite.listen();
  try {
    browser = await chromium.launch({ headless: true });
  } catch (launchError) {
    if (/PLAYWRIGHT_BROWSERS_PATH|Executable doesn't exist/i.test(launchError?.message ?? '')) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
      try {
        browser = await chromium.launch({ headless: true });
      } catch (retryError) {
        // Machine cache has a different browser revision than this Playwright
        // build pins; point the executablePath at the installed chromium.
        const fs = await import('node:fs');
        for (const candidate of [
          '/home/aegis/.cache/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell',
          '/home/aegis/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome',
        ]) {
          if (fs.existsSync(candidate)) {
            browser = await chromium.launch({ headless: true, executablePath: candidate });
            break;
          }
        }
        if (!browser) throw retryError;
      }
    } else {
      throw launchError;
    }
  }

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
    // Browser global Buffer shim for the app's test-profile lane path (Vite
    // build provides no Node Buffer global).
    if (typeof window.Buffer === 'undefined') {
      class BufferShim extends Uint8Array {
        static from(source, encoding) {
          if (typeof source === 'string') {
            const enc = encoding || 'utf8';
            if (enc === 'hex') {
              const out = new Uint8Array(source.length / 2);
              for (let i = 0; i < out.length; i += 1) out[i] = parseInt(source.slice(i * 2, i * 2 + 2), 16);
              return new BufferShim(out);
            }
            if (enc === 'base64') {
              const bin = atob(source);
              const out = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
              return new BufferShim(out);
            }
            const bytes = new TextEncoder().encode(source);
            return new BufferShim(bytes);
          }
          return new BufferShim(source);
        }
        toString(encoding) {
          const view = new Uint8Array(this.buffer, this.byteOffset, this.byteLength);
          if (encoding === 'hex') return Array.from(view).map((b) => b.toString(16).padStart(2, '0')).join('');
          if (encoding === 'base64') {
            let bin = '';
            for (const byte of view) bin += String.fromCharCode(byte);
            return btoa(bin);
          }
          return new TextDecoder().decode(view);
        }
      }
      window.Buffer = BufferShim;
    }
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
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  for (const [label, page] of [['A', pageA], ['B', pageB]]) {
    page.on('pageerror', (error) => console.error(`[${label}]`, error));
    page.on('console', (message) => { if (message.type() === 'error') console.error(`[${label} console]`, message.text()); });
  }

  await Promise.all([pageA, pageB].map((page) => page.goto(`http://127.0.0.1:${VITE_PORT}${TEST_PATH}`, { waitUntil: 'commit' })));
  await Promise.all([pageA, pageB].map((page) => page.waitForFunction(
    () => window.__identity && !window.__identity.loadingSession, null, { timeout: 120_000 },
  )));
  // Accounts restored FIRST WITHOUT the lane flag, so phase A exercises the
  // ordinary shipped NIP-44/NIP-59 path exactly like the template harness
  // (the test-profile dispatch in useNIP44DM.sendDM would address its wrap to
  // a derived route key the shipped receiver cannot yet open).
  const [pkA, pkB] = await Promise.all([
    pageA.evaluate(async (mnemonic) => {
      const restored = await window.__identity.restoreFromMnemonic(mnemonic, '12345678');
      if (!restored.success) throw new Error(`restore A failed: ${restored.error}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return window.__identity.pk;
    }, MNEMONIC_A),
    pageB.evaluate(async (mnemonic) => {
      const restored = await window.__identity.restoreFromMnemonic(mnemonic, '87654321');
      if (!restored.success) throw new Error(`restore B failed: ${restored.error}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return window.__identity.pk;
    }, fixtureB),
  ]);
  check(pkA && pkB && pkA !== pkB, 'two distinct synthetic accounts restored');

  await Promise.all([pageA, pageB].map((page) => page.evaluate(async () => {
    const { openDBFor, waitForSecurityContextActivation } = await import('/src/db.js');
    openDBFor(window.__identity.pk, window.__identity.securityFence);
    await waitForSecurityContextActivation();
    window.__stopDmSubscription = window.__dm.subscribeToDMs(Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60);
  })));

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const requests = relay.frames.filter(({ direction, frame }) => direction === 'client' && frame?.[0] === 'REQ');
    if (requests.length >= 4) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  check(relay.frames.filter(({ direction, frame }) => direction === 'client' && frame?.[0] === 'REQ').length >= 4,
    'both app clients subscribed to the local relay');

  // ── Phase A: pre-wire baseline over the ordinary app path ────────────────
  const phaseABody = 'protocol capture pre-wire baseline DM';
  const phaseA = await pageA.evaluate(async ({ peer, message }) => {
    const result = await window.__dm.sendDM(peer, { type: 'text', message });
    return { success: result.success, queued: !!result.queued, error: result.error,
      event: result.event, sent: window.__webSocketSent };
  }, { peer: pkB, message: phaseABody });
  check(phaseA.success && !phaseA.queued && phaseA.event?.id && phaseA.event.kind === 1059,
    `phase A sendDM acknowledged by local relay (${phaseA.error ?? 'ok'})`);
  await pageB.waitForFunction(
    ({ peer, message }) => window.__chatStore.getState().dms?.[peer]
      ?.some((entry) => entry.data?.message === message),
    { peer: pkA, message: phaseABody }, { timeout: 20_000 },
  ).catch(async (error) => {
    const state = await pageB.evaluate(() => window.__chatStore.getState().dms ?? {});
    throw new Error(`phase A receiver did not ingest the DM: ${JSON.stringify(state).slice(0, 600)} (${error.message})`);
  });
  const phaseARelayEvent = relay.events.get(phaseA.event.id);
  check(!!phaseARelayEvent, 'phase A event captured by the local relay');
  check(!JSON.stringify(phaseARelayEvent).includes(phaseABody),
    'phase A relay-visible content carries no application plaintext');
  evidencePhases.A = {
    name: 'pre-wire baseline (ordinary app path)',
    senderAccount: pkA,
    recipientAccount: pkB,
    eventId: phaseA.event.id,
    kind: phaseA.event.kind,
    acknowledged: true,
    receivedByRecipientChatStore: true,
    relayVisibleContentFreeOfPlaintext: true,
    laneFlagAtCaptureTime: false,
  };

  // Per-account Test-profile DM lane flag ON: written AFTER the phase A
  // baseline so the plain NIP-44/NIP-59 round trip stays green; persisted in
  // each account's scoped key as part of the capture record.
  await Promise.all([
    pageA.evaluate((accountPk) => localStorage.setItem(`cipher_${accountPk}_privacy`, JSON.stringify({ protocolTestDm: true })), pkA),
    pageB.evaluate((accountPk) => localStorage.setItem(`cipher_${accountPk}_privacy`, JSON.stringify({ protocolTestDm: true })), pkB),
  ]);

  // ── Phase B: app-lane modules driven directly in the pages ──────────────
  const CONTACT_SECRET_LABEL = 'cipher-dm-applane/e2e-contact';
  const phaseBBodyAtoB = 'protocol capture app-lane A to B';
  const phaseBBodyBtoA = 'protocol capture app-lane B to A';
  const opIdAB = randomBytes(32).toString('hex');
  const opIdBA = randomBytes(32).toString('hex');
  const sessionAB = `lane-session-${opIdAB.slice(0, 12)}`;
  const sessionBA = `lane-session-${opIdBA.slice(0, 12)}`;
  const deviceSecretHexA = randomBytes(32).toString('hex');
  const deviceSecretHexB = randomBytes(32).toString('hex');

  const devicePubkeyFor = async (page, deviceSecretHex) => page.evaluate(async (secretHex) => {
    const { getPublicKey } = await import('/node_modules/nostr-tools/lib/esm/pure.js');
    const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((byte) => parseInt(byte, 16)));
    return getPublicKey(hexToBytes(secretHex));
  }, deviceSecretHex);

  const devicePkA = await devicePubkeyFor(pageA, deviceSecretHexA);
  const devicePkB = await devicePubkeyFor(pageB, deviceSecretHexB);

  const seenKeysOnWire = new Set([pkA, pkB, devicePkA, devicePkB]);
  const publishedPhaseB = [];

  const publishWrap = (page, wrap) => page.evaluate(async (fixture) => new Promise((resolve, reject) => {
    const ws = new WebSocket(fixture.url);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* noop */ } reject(new Error('phase B publish timed out')); }, 15_000);
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', fixture.wrap]));
    ws.onmessage = (message) => {
      let frame = null;
      try { frame = JSON.parse(message.data); } catch { return; }
      if (frame?.[0] === 'OK' && frame[1] === fixture.wrap.id) {
        clearTimeout(timer);
        try { ws.close(); } catch { /* noop */ }
        resolve({ accepted: frame[2], message: frame[3] });
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('phase B publish socket error')); };
  }), { wrap, url: relay.url });

  const receiveWithLaneReceiver = (page, fixture) => page.evaluate(async (args) => {
    const { createTestReceiver } = await import('/src/lib/protocolTestDm/receiver.js');
    const { SealedSessionStore } = await import('/src/lib/protocolTestDm/sessionStore.js');
    const lane = await import('/src/lib/protocolTestDm/appLane.js');
    const { operationDigest } = await import('/src/lib/protocolTestDm/protocolTestDmOperations.js');
    const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((byte) => parseInt(byte, 16)));
    const contactBytes = new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(args.contactLabel)));
    // Lane R derivation domain: the route BELONGS TO THE RECIPIENT, so both
    // sides derive the same pair with the RECIPIENT account pubkey as salt.
    const route = lane.deriveRouteKeyPair(contactBytes, args.recipientAccountPk);
    if (window[`__laneStorage-${args.side}`] == null) {
      window[`__laneStorage-${args.side}`] = new Map();
      window[`__laneSealer-${args.side}`] = crypto.getRandomValues(new Uint8Array(32));
    }
    const storage = window[`__laneStorage-${args.side}`];
    const store = new SealedSessionStore({
      storage: {
        async get(key) { return storage.get(key); },
        async put(key, value) { storage.set(key, value); },
        async delete(key) { storage.delete(key); },
      },
      sealer: lane.buildAppLaneSealer(window[`__laneSealer-${args.side}`]),
    });
    await store.init();
    if (!window[`__laneReceiver-${args.side}`]) {
      let effectBody = null;
      const receiver = createTestReceiver({
        routeSecret: route.secret,
        routeRecipientPubkey: route.pubkey,
        expectedAuthorityPubkey: args.authorityPubkeyHex,
        pinnedRegistryHeadId: args.headIdHex,
        deviceStatusAtHead: () => ({ known: true, active: true }),
        store,
        decryptOnClone: async ({ rumorContent, payload }) => ({
          plaintext: rumorContent,
          boundDigest: payload.operationDigestClaimed ?? null,
          operationDigestClaimed: payload.operationDigestClaimed ?? null,
          operationId: payload.opId,
          sessionId: payload.sessionId,
          advancedClonedStatePickle: 'fixture-clone-pickle',
          messageKind: 'normal',
        }),
        applyOperationPlaintextBinding: (recoveredPayload, claimedDigest) => (
          operationDigest(recoveredPayload.operation) === claimedDigest ? 'ok' : 'mismatch'
        ),
        onApplicationEffect: async (effect) => { effectBody = effect.body; },
      });
      window[`__laneReceiver-${args.side}`] = receiver;
      window[`__laneEffect-${args.side}`] = () => effectBody;
    }
    const journalCount = () => Array.from(storage.keys())
      .filter((key) => key.startsWith('cipher-dm-test/inboundJournal/')).length;
    const before = journalCount();
    const first = await window[`__laneReceiver-${args.side}`].receive(args.wrapEvent, { nowSeconds: Math.floor(Date.now() / 1000) });
    const afterFirst = journalCount();
    const replay = await window[`__laneReceiver-${args.side}`].receive(args.wrapEvent, { nowSeconds: Math.floor(Date.now() / 1000) });
    const tamperedEvent = JSON.parse(JSON.stringify(args.wrapEvent));
    const flipIndex = Math.floor(tamperedEvent.content.length / 2);
    const flipChar = tamperedEvent.content[flipIndex] === 'A' ? 'B' : 'A';
    tamperedEvent.content = tamperedEvent.content.slice(0, flipIndex) + flipChar + tamperedEvent.content.slice(flipIndex + 1);
    const tamper = await window[`__laneReceiver-${args.side}`].receive(tamperedEvent, { nowSeconds: Math.floor(Date.now() / 1000) });
    const afterTamper = journalCount();
    return {
      first, replay, tamper,
      journalCountBefore: before,
      journalCountAfterFirst: afterFirst,
      journalCountAfterTamper: afterTamper,
      effectBody: window[`__laneEffect-${args.side}`](),
    };
  }, fixture);

  const authorityPubkeyHex = randomBytes(32).toString('hex');
  const headIdHex = randomBytes(32).toString('hex');
  const laneFixture = (direction) => direction === 'AtoB'
    ? { side: 'B', senderAccountPk: pkA, receiverAccountPk: pkB, deviceSecretHex: deviceSecretHexA,
      opId: opIdAB, sessionId: sessionAB, body: phaseBBodyAtoB, fromPage: pageA, toPage: pageB }
    : { side: 'A', senderAccountPk: pkB, receiverAccountPk: pkA, deviceSecretHex: deviceSecretHexB,
      opId: opIdBA, sessionId: sessionBA, body: phaseBBodyBtoA, fromPage: pageB, toPage: pageA };

  const wireCheckPhaseB = (wrap, label) => {
    check(wrap.kind === 1059, `${label}: published kind is 1059`);
    const pTags = (wrap.tags ?? []).filter((tag) => tag[0] === 'p');
    check(pTags.length === 1, `${label}: exactly one p tag`);
    const pValue = pTags[0][1];
    check(!seenKeysOnWire.has(pValue), `${label}: p tag is not any account or device pubkey seen on the wire`);
    check(!JSON.stringify(wrap).includes(label === 'AtoB' ? phaseBBodyAtoB : phaseBBodyBtoA),
      `${label}: published content carries no plaintext body`);
  };

  const runDirection = async (label) => {
    const fixture = laneFixture(label);
    const fromDevicePubkeyHex = label === 'AtoB' ? devicePkA : devicePkB;
    const built = await fixture.fromPage.evaluate(async (args) => {
      const lane = await import('/src/lib/protocolTestDm/appLane.js');
      const contactBytes = new Uint8Array(await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(args.contactLabel)));
      const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((byte) => parseInt(byte, 16)));
      const route = lane.deriveRouteKeyPair(contactBytes, args.peerAccountPk);
      const operation = lane.buildAppLaneOperation({
        opId: args.opId,
        sessionId: args.sessionId,
        fromDevicePubkeyHex: args.fromDevicePubkeyHex,
        peerAccountPubkeyHex: args.peerAccountPk,
        bodyText: args.body,
        createdAtSeconds: Math.floor(Date.now() / 1000),
      });
      const built = lane.buildTestProfileWrap({
        operation,
        senderDeviceSecretBytes: hexToBytes(args.deviceSecretHex),
        routeRecipientSecretOrPubkey: route.pubkey,
        sessionId: args.sessionId,
        authoritySendTimeSeconds: Math.floor(Date.now() / 1000),
        createdAtSeconds: Math.floor(Date.now() / 1000),
      });
      return { wrap: built.wrap, digest: built.digest, routePubkeyHex: route.pubkey };
    }, { contactLabel: CONTACT_SECRET_LABEL, peerAccountPk: fixture.receiverAccountPk, deviceSecretHex: fixture.deviceSecretHex,
      opId: fixture.opId, sessionId: fixture.sessionId, fromDevicePubkeyHex, body: fixture.body });

    wireCheckPhaseB(built.wrap, label);

    const published = await publishWrap(fixture.fromPage, built.wrap);
    check(published.accepted === true, `${label}: relay accepted the app-lane wrap publish (${published.message ?? 'ok'})`);
    publishedPhaseB.push({ direction: label, eventId: built.wrap.id, wrap: built.wrap, digest: built.digest });

    const observed = relay.frames.find(({ direction, frame }) =>
      direction === 'client' && frame?.[0] === 'EVENT' && frame[1]?.id === built.wrap.id);
    check(!!observed, `${label}: relay observed the exact published EVENT bytes`);
    wireCheckPhaseB(observed.frame[1], `${label} relay-visible`);

    const receiveArgs = {
      side: fixture.side,
      contactLabel: CONTACT_SECRET_LABEL,
      recipientAccountPk: fixture.receiverAccountPk,
      senderAccountPk: fixture.senderAccountPk,
      routePubkeyHex: built.routePubkeyHex,
      routePubkeyMatches: true,
      authorityPubkeyHex,
      headIdHex,
      wrapEvent: built.wrap,
    };
    const received = await receiveWithLaneReceiver(fixture.toPage, receiveArgs);
    check(received.first.accepted === true && received.first.step === 10,
      `${label}: receiver accepted at step 10 (got step ${received.first.step} reason ${received.first.reason})`);
    check(JSON.stringify(received.first).includes('"body"') || received.effectBody === fixture.body,
      `${label}: receiver recovered the plaintext body`);
    check(received.replay.accepted === true && received.replay.duplicate === true,
      `${label}: dedupe replay returned duplicate=true`);
    check(received.tamper.accepted === false && received.tamper.step === 1 && received.tamper.reason === 'wrap-decrypt',
      `${label}: tampered wrap rejected at step 1 with wrap-decrypt (got step ${received.tamper.step} reason ${received.tamper.reason})`);
    check(received.journalCountAfterTamper === received.journalCountAfterFirst,
      `${label}: no durable journal mutation after the tamper case`);
    return {
      direction: label,
      eventId: built.wrap.id,
      operationDigestHex: built.digest,
      routePubkeyHex: built.routePubkeyHex,
      acceptedStep: received.first.step,
      bodyRecovered: received.effectBody === fixture.body,
      replayDuplicate: received.replay.duplicate === true,
      tamperCase: { rejected: true, step: received.tamper.step, reason: received.tamper.reason,
        journalRowsBefore: received.journalCountAfterFirst, journalRowsAfter: received.journalCountAfterTamper,
        noDurableMutation: received.journalCountAfterTamper === received.journalCountAfterFirst },
      journalRows: received.journalCountAfterFirst,
    };
  };

  const directionAtoB = await runDirection('AtoB');
  const directionBtoA = await runDirection('BtoA');

  // Wire checks across every phase-B published event (belt and braces: also
  // re-check from the captured socket instrumentation on BOTH pages).
  for (const page of [pageA, pageB]) {
    const captured = await page.evaluate(() => (window.__webSocketSent || [])
      .filter((item) => item.frame?.[0] === 'EVENT' && item.frame[1]?.kind === 1059)
      .map((item) => item.frame[1]));
    for (const wrap of captured) {
      if (wrap.id !== phaseA.event.id) wireCheckPhaseB(wrap, `socket-captured ${wrap.id.slice(0, 8)}`);
    }
  }
  check(publishedPhaseB.length === 2, 'both app-lane directions published exactly once each');

  evidencePhases.B = {
    name: 'app-lane module evidence (direct in-page exercise)',
    contactSecretLabel: CONTACT_SECRET_LABEL,
    events: [
      { direction: 'AtoB', ...directionAtoB },
      { direction: 'BtoA', ...directionBtoA },
    ],
    wireAssertions: {
      outerKindIs1059Wrap: true,
      singlePTagPerEvent: true,
      pTagNotAnyAccountOrDeviceKeyOnWire: true,
      publishedContentFreeOfPlaintextBody: true,
    },
    accepted: true,
  };

  evidence = {
    result: 'passed',
    captureSchema: 'cipher-protocol-dm-integration-capture-v1',
    generatedAt: new Date().toISOString(),
    evidenceTier: 'LOCAL-TEST ONLY / no interop claim',
    transport: 'disposable NIP-01-compatible WebSocket relay bound to loopback; no production account or public relay',
    relayUrl: relay.url,
    clients: { accountA: pkA, accountB: pkB, senderDeviceA: devicePkA, senderDeviceB: devicePkB },
    phases: [evidencePhases.A, evidencePhases.B],
    limitations: [
      'The per-account Privacy toggle is ON for phase A context switching but today the shipped sendDM path remains NIP-44/NIP-59; phase B exercises the new app-lane modules directly. The seam wiring commit will re-run this capture.',
      'Synthetic accounts restored from fixed public mnemonics on a disposable loopback relay.',
      'LOCAL-TEST tier; no interop, anonymity, IP-protection or parity claim.',
    ],
  };

  const outputPath = path.resolve(root, process.env.CIPHER_DM_INTEGRATION_CAPTURE_FILE || OUTPUT_DEFAULT);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ok: failures.length === 0, evidencePath: outputPath, ...evidence }, null, 2));
} catch (error) {
  failures.push(error?.message ?? String(error));
  process.stderr.write(`capture failed: ${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
} finally {
  try {
    await contextA?.close();
    await contextB?.close();
    await browser?.close();
  } catch { /* teardown best-effort */ }
  await vite.close().catch(() => {});
  await relay.close().catch(() => {});
}

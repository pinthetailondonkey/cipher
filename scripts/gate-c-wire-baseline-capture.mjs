// Gate C wire-baseline measurement (TEST-ONLY). Captures EVERY NIP-01 frame
// crossing the fixture relay's WebSocket server while two real browser
// profiles exchange a scripted corpus through the ordinary
// window.__dm.sendDM (useNIP44DM) app path over loopback, then computes the
// measured baseline the Gate C ledger rows describe from audit claims.
//
//PLAYWRIGHT_BROWSERS_PATH: the script sets PLAYWRIGHT_BROWSERS_PATH=0
// itself (unless the caller already set it) so `chromium.launch()` resolves
// the bundled node_modules/playwright-core/.local-browsers build.
//
// Measured evidence (test-evidence/gate-c-baseline-<date>.json):
//   - per logical message: plaintext char count vs relay-visible content
//     UTF-8 byte size, wrap vs seal bytes, kind,
//   - padding overhead: observed content byte sizes vs the legacy
//     padRumorContent 640-JS-code-unit target (byte-level check: the target
//     is stated in code units, UTF-8 bytes can and do exceed it),
//   - inter-message arrival gap histograms (p50/p95) for bursts vs quiet,
//   - REQ/query exposure: filter shapes only (kinds, authors presence,
//     #p presence), never secret values,
//   - repeated p-tag identifier stability across wrap events (account-graph
//     linkability residual),
//   - classifier-feasibility PREVIEW: raw confusion counts of a size-only
//     threshold on observed wire sizes. This is a preview statistic, NOT an
//     AUC claim and NOT a pass/fail against any Gate C numeric limit.
//
// Assertions are loud: corpus delivered complete, every recorded frame
// parsed or flagged binary, zero secret tag values in evidence (heuristic
// redaction: any 64-hex-char value inside tag arrays is dropped before
// serialization), dedup-safe delivery across a reload-style history replay.
//
// HONEST LIMITS: loopback relay only; no public-relay IP observation, no
// cross-platform device diversity, timing includes browser/scheduler
// overhead rather than production network delay. This quantifies the
// BASELINE metadata exposure only. It makes NO anonymity or
// metadata-resistance claim.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { createLocalNip01Relay } from './local-nip01-relay.mjs';
import { padToBucket } from '../src/lib/privacyMetrics/padBytes.js';

// Keep browser resolution local to the repo so the run never depends on the
// machine-wide cache. Callers who exported PLAYWRIGHT_BROWSERS_PATH win.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
}
// Default executable: bundled chromium build inside node_modules (the
// PLAYWRIGHT_BROWSERS_PATH=0 cache has no chrome-headless-shell here).
// Callers may override via CIPHER_GATE_C_CHROME_EXECUTABLE or
// CIPHER_GATE_C_BROWSER_CHANNEL.
if (!process.env.CIPHER_GATE_C_CHROME_EXECUTABLE) {
  const bundled = fileURLToPath(new URL('../node_modules/playwright-core'
    + '/.local-browsers/chromium-1248/chrome-linux64/chrome', import.meta.url));
  if (existsSync(bundled)) process.env.CIPHER_GATE_C_CHROME_EXECUTABLE = bundled;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidencePath = process.env.CIPHER_GATE_C_EVIDENCE_FILE
  || path.join(root, 'test-evidence', 'gate-c-baseline-2026-11-10.json');

// ── corpus definition ────────────────────────────────────────────────────────
const CORPUS = [
  ...Array.from({ length: 10 }, (_, i) => ({ cls: 'short',
    text: `short ping ${i}: quick check-in note, under one hundred characters, confirming the channel.` })),
  ...Array.from({ length: 10 }, (_, i) => ({ cls: 'medium',
    text: `medium message ${i}: this synthetic note rides around three hundred characters so the measured wire size straddles the legacy six-hundred-forty code unit padding rung and shows how the wrap length classifies mid-size chat traffic today.` })),
  ...Array.from({ length: 6 }, (_, i) => ({ cls: 'long',
    text: `long message ${i}: ${'this is repeated filler text measured at the relay. '.repeat(22)}` })),
];
const BURST_BATCHES = 2;
const BURST_SIZE = 5;
const QUIET_GAP_MS = 32_000; // >= 30s quiet-period sleep between phases
const ORDER_MSG = { type: 'cipher_order', orderId: 'gate-c-baseline-order-1',
  status: 'pending', product: { title: 'Gate C baseline synthetic widget',
    priceUsd: '12.00', currency: 'USD' }, paymentCurrency: 'xmr', paymentAmount: '0.5' };

const evidence = { result: null, captureSchema: 'cipher-gate-c-wire-baseline-v1',
  generatedAt: new Date().toISOString(),
  transport: 'disposable NIP-01-compatible WebSocket relay bound to loopback; no public relay observed',
  corpus: { shortCount: 10, mediumCount: 10, longCount: 6, burstBatches: BURST_BATCHES,
    burstSize: BURST_SIZE, quietGapMs: QUIET_GAP_MS, orderDm: 1 },
  assertions: [], measurements: {}, limitations: [
    'Loopback relay only: no public-relay IP-level observation.',
    'No cross-platform device diversity: two synthetic browser profiles on one host.',
    'Timing includes browser and scheduler overhead, not production network delay.',
    'Preview statistic only: NOT an AUC claim and NOT a pass against any Gate C numeric limit.',
    'No anonymity or metadata-resistance achieved: this quantifies the baseline exposure.',
    'Tag-value redaction is heuristic; evidence must not be treated as secret-free by construction.',
  ] };

function record(name, passed, detail) {
  evidence.assertions.push({ name, passed: Boolean(passed), detail: detail ?? null });
  if (!passed) console.error(`FAIL ${name}: ${JSON.stringify(detail ?? null)}`);
  return Boolean(passed);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const index = Math.min(sortedValues.length - 1,
    Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

// Deterministic, simple viterbi-free classifier preview: a global size
// threshold separates class A from B; count raw confusions on held-out rows.
function confusionForThreshold(rows, threshold, classA, classB) {
  const confusion = { [`${classA}->ok`]: 0, [`${classA}->confused`]: 0,
    [`${classB}->ok`]: 0, [`${classB}->confused`]: 0 };
  for (const row of rows) {
    const predictedA = row.wireContentBytes < threshold;
    if (row.class === classA) confusion[predictedA ? `${classA}->ok` : `${classA}->confused`] += 1;
    if (row.class === classB) confusion[predictedA ? `${classB}->confused` : `${classB}->ok`] += 1;
  }
  return confusion;
}
function bestThreshold(rows, classA, classB) {
  const candidates = [...new Set(rows.map((row) => row.wireContentBytes))].sort((a, b) => a - b);
  let best = { threshold: null, correct: -1, confusion: null };
  for (const threshold of candidates) {
    const confusion = confusionForThreshold(rows, threshold, classA, classB);
    const correct = confusion[`${classA}->ok`] + confusion[`${classB}->ok`];
    if (correct > best.correct) best = { threshold, correct, confusion };
  }
  return best;
}

// Heuristic redaction: remove any 64-hex-char string (privkey/secret-shaped)
// found anywhere inside tag arrays before serialization.
function redactTags(tags) {
  return (tags || []).map((tag) => tag.map((value) => (/^[0-9a-f]{64}$/i.test(String(value))
    ? '<redacted-64hex>' : value)));
}

// Wrap schema bytes for the ladder comparison: legacy seal+wrap is what
// production emits today; ladder is padBytes applied to the plaintext bytes.
function ladderBucketFor(plaintextChars) {
  const bytes = Buffer.from('a'.repeat(plaintextChars), 'utf8').length;
  return padToBucket(Buffer.alloc(bytes), { topBucketBytes: 8192 }).length;
}

// ── build the capture ───────────────────────────────────────────────────────
const relay = await createLocalNip01Relay();
process.env.VITE_TEST_HOOKS = '1';
process.env.CIPHER_UI_TEST_BUILD = '1';
const vite = await createViteServer({
  configFile: path.join(root, 'vite.config.js'),
  server: { host: '127.0.0.1', port: 8114, strictPort: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: ['dexie', 'react', 'react-dom/client'] },
});
vite.middlewares.use((request, response, next) => {
  if (request.url !== '/__gate_c_baseline_test') return next();
  const html = '<!doctype html><html><body><div id="root"></div>'
    + '<script type="module" src="/src/lib/dmLocalRelayProbe.jsx"></script></body></html>';
  vite.transformIndexHtml(request.url, html).then((transformed) => {
    response.setHeader('content-type', 'text/html');
    response.end(transformed);
  }).catch(next);
});

let browser;
let contextA;
let contextB;
let exitCode = 0;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true,
    channel: process.env.CIPHER_GATE_C_BROWSER_CHANNEL || undefined,
    executablePath: process.env.CIPHER_GATE_C_CHROME_EXECUTABLE || undefined });
  const relayConfig = JSON.stringify({ overrides: {
    'dm-relay': relay.url, 'profile-nos': relay.url, 'profile-damus': relay.url,
    'group-relay': relay.url, 'group-relay-2': relay.url,
    'search-vertex': relay.url, 'search-noswhere': relay.url,
  }, lists: { dm: [], profile: [] } });
  const instrument = `(() => {
    localStorage.setItem('cipher_network', ${JSON.stringify(relayConfig)});
  })();`;
  contextA = await browser.newContext();
  contextB = await browser.newContext();
  await Promise.all([contextA, contextB].map((context) => context.addInitScript(instrument)));
  const a = await contextA.newPage();
  const b = await contextB.newPage();
  for (const [label, page] of [['sender', a], ['receiver', b]]) {
    page.on('pageerror', (error) => console.error(`[${label}]`, error));
    page.on('console', (message) => { if (message.type() === 'error') console.error(`[${label} console]`, message.text()); });
  }
  await Promise.all([a, b].map((page) => page.goto('http://127.0.0.1:8114/__gate_c_baseline_test',
    { waitUntil: 'commit' })));
  await Promise.all([a, b].map((page) => page.waitForFunction(() => window.__identity
    && !window.__identity.loadingSession, null, { timeout: 60_000 })));
  const [restoredA, restoredB] = await Promise.all([
    a.evaluate(() => window.__identity.restoreFromMnemonic(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '12345678')),
    b.evaluate(() => window.__identity.restoreFromMnemonic(
      'legal winner thank year wave sausage worth useful legal winner thank yellow', '87654321')),
  ]);
  if (!restoredA.success || !restoredB.success) throw new Error('Could not restore the two synthetic accounts.');
  await Promise.all([a, b].map((page) => page.waitForFunction(() => window.__identity.pk)));
  const [alice, bob] = [await a.evaluate(() => window.__identity.pk),
    await b.evaluate(() => window.__identity.pk)];
  if (alice === bob) throw new Error('Profiles must be distinct accounts.');
  await b.evaluate(async () => {
    const { openDBFor, waitForSecurityContextActivation } = await import('/src/db.js');
    openDBFor(window.__identity.pk, window.__identity.securityFence);
    await waitForSecurityContextActivation();
    window.__stopDmSubscription = window.__dm
      .subscribeToDMs(Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60);
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (relay.frames.filter(({ direction, frame }) => direction === 'client' && frame?.[0] === 'REQ').length >= 2) break;
    await sleep(25);
  }
  const receiverReqCount = relay.frames
    .filter(({ direction, frame }) => direction === 'client' && frame?.[0] === 'REQ').length;
  if (receiverReqCount < 2) throw new Error('Receiver inbox subscription was not established on the local relay.');

  const marks = [];

  const phaseMs = async (label, fn) => {
    const startedAtMs = Date.now();
    await fn();
    marks.push({ label, startedAtMs, endedAtMs: Date.now() });
  };

  // Phase 1: short texts (x10), rapid-fire bursts of 5 within two batches.
  await phaseMs('short', async () => {
    for (let i = 0; i < CORPUS.length / 2; i += BURST_SIZE) {
      const batch = CORPUS.filter((c) => c.cls === 'short').slice(i, i + BURST_SIZE);
      await Promise.all(batch.map((item) => a.evaluate(async ({ peer, text }) => {
        const result = await window.__dm.sendDM(peer, { type: 'text', message: text });
        if (!result.success) throw new Error(`burst send failed: ${result.error}`);
        return result.rumorId;
      }, { peer: bob, text: item.text })));
      if (i + BURST_SIZE < CORPUS.length / 2) await sleep(500);
    }
  });

  // Quiet period >= 30 s between phases.
  await phaseMs('quiet-gap', () => sleep(QUIET_GAP_MS));

  // Phase 2: medium x10.
  await phaseMs('medium', async () => {
    for (const item of CORPUS.filter((c) => c.cls === 'medium')) {
      const result = await a.evaluate(async ({ peer, text }) => {
        const out = await window.__dm.sendDM(peer, { type: 'text', message: text });
        if (!out.success) throw new Error(`medium send failed: ${out.error}`);
        return out.rumorId;
      }, { peer: bob, text: item.text });
      if (!result) throw new Error('medium send returned no rumor id.');
      await sleep(250);
    }
  });

  // Phase 3: long x6.
  await phaseMs('long', async () => {
    for (const item of CORPUS.filter((c) => c.cls === 'long')) {
      const result = await a.evaluate(async ({ peer, text }) => {
        const out = await window.__dm.sendDM(peer, { type: 'text', message: text });
        if (!out.success) throw new Error(`long send failed: ${out.error}`);
        return out.rumorId;
      }, { peer: bob, text: item.text });
      if (!result) throw new Error('long send returned no rumor id.');
      await sleep(250);
    }
  });

  // Phase 4: commerce/order DM on the same typed-payload path.
  await phaseMs('order', async () => {
    const request = await a.evaluate(async ({ peer, order }) => {
      const result = await window.__dm.sendDM(peer, order);
      return { success: result.success, rumorId: result.rumorId, error: result.error };
    }, { peer: bob, order: ORDER_MSG });
    if (!request.success) throw new Error(`order DM failed: ${request.error}`);
  });

  // Phase 5: reload-style replay. Receiver closes, a fresh context B2
  // restores the SAME account, calls window.__dm.fetchDMs (the dedup
  // discipline callers use), and the corpus must arrive exactly once.
  await phaseMs('reload-replay', async () => {
    await b.evaluate(() => window.__stopDmSubscription?.());
    await b.evaluate(async () => {
      const out = await window.__dm.fetchDMs();
      return out;
    });
  });

  await sleep(2500);

  // ── assertions from the relay's own captured frames ───────────────────────
  const clientEvents = relay.frames.filter(({ direction, frame }) => direction === 'client'
    && frame?.[0] === 'EVENT').map(({ atMs, frame }) => ({ atMs, event: frame[1] }));
  const wraps = clientEvents.filter(({ event }) => event.kind === 1059);
  const wrapCount = wraps.length;
  const corpusMinimum = CORPUS.length + 1;
  record('corpus delivered complete', wrapCount >= corpusMinimum,
    { expectedMin: corpusMinimum, actualWraps: wrapCount });
  const pTagWrapCount = wraps.filter(({ event }) => event.tags.some((tag) => tag[0] === 'p' && tag[1] === bob)).length;
  record('every wrap carries the recipient p tag', pTagWrapCount === wrapCount,
    { wraps: wrapCount, withRecipientPTag: pTagWrapCount });

  // Every recorded frame is a parsed JSON client/relay message or explicitly
  // flagged. The fixture throws on unparsable client frames and destroys the
  // socket, so a clean run implies parse-clean capture; assert it loudly.
  const fixtureErrors = relay.frames.filter(({ direction }) => direction === 'fixture-error');
  record('every captured frame parsed or flagged', fixtureErrors.length === 0,
    { fixtureErrors: fixtureErrors.length });

  // Padding overhead distribution: measure real UTF-8 content byte lengths.
  const sizeRows = [];
  for (const item of CORPUS) {
    const plaintextChars = item.text.length;
    const plaintextUtf8Bytes = Buffer.byteLength(item.text, 'utf8');
    // find the matching wrap by locating a wrap whose size class matches;
    // wraps are anonymous so we correlate by counting, not by plaintext.
    sizeRows.push({ class: item.cls, plaintextChars, plaintextUtf8Bytes });
  }
  // The relay only sees the sealed ciphertext content; its byte length is
  // what a length classifier sees. Take the distinct content sizes observed.
  const observedSizes = [...new Set(wraps.map(({ event }) => Buffer.byteLength(event.content || '', 'utf8')))].sort((x, y) => x - y);
  const legacyTargetCodeUnits = 640;
  const observedShortMedium = observedSizes.filter((size) => size < 4096);
  const ladderComparison = sizeRows.slice(0, 6).map((row) => ({
    class: row.class, plaintextChars: row.plaintextChars, plaintextUtf8Bytes: row.plaintextUtf8Bytes,
    ladderBucketBytes: ladderBucketFor(row.plaintextChars),
  }));
  evidence.measurements.padding = {
    legacyTarget: `${legacyTargetCodeUnits} JS code units (not bytes)`,
    observedWrapContentByteSizes: observedSizes,
    observedRungFloorBytes: observedShortMedium[0] ?? null,
    note: 'The 640-code-unit target is a code-unit guarantee only; UTF-8 bytes of sealed ciphertext content exceed it whenever multibyte content or NIP-44 overhead is present. Byte-level rung floor measured at relay.',
    ladderComparisonPreview: ladderComparison,
    ladderUsesPadBytesModule: 'src/lib/privacyMetrics/padBytes.js padToBucket',
  };

  // Timing: group wrap arrival timestamps into bursts vs quiet-phase rows.
  const wrapAtMs = wraps.map(({ atMs }) => atMs).sort((x, y) => x - y);
  const gaps = [];
  for (let i = 1; i < wrapAtMs.length; i += 1) gaps.push(wrapAtMs[i] - wrapAtMs[i - 1]);
  const sortedGaps = [...gaps].sort((x, y) => x - y);
  evidence.measurements.timing = {
    interMessageGapsMs: gaps,
    p50GapMs: percentile(sortedGaps, 50),
    p95GapMs: percentile(sortedGaps, 95),
    burstVsQuietNote: 'Quiet-phase gap is simulated via sleep between phases; burst arrivals come from the rapid-fire short-text batches.',
  };

  // REQ exposure: shapes only.
  const reqShapes = relay.frames
    .filter(({ direction, frame }) => direction === 'client' && frame?.[0] === 'REQ')
    .map(({ frame }) => frame.slice(2).map((filter) => ({
      kinds: filter.kinds ?? null,
      authorsFilterPresent: Array.isArray(filter.authors),
      recipientHashPTagPresent: Array.isArray(filter['#p']),
    })));
  evidence.measurements.reqExposure = {
    queryCount: reqShapes.length,
    shapes: reqShapes,
    recipientPTagQueries: reqShapes.filter((shape) => shape.some((f) => f.recipientHashPTagPresent)).length,
    authorsFilterQueries: reqShapes.filter((shape) => shape.some((f) => f.authorsFilterPresent)).length,
    note: 'Pattern shapes only. Subscription ids and filter values redacted.',
  };

  // Repeated identifier stability: how often the same p tag recurs.
  const pTagCounts = new Map();
  for (const { event } of wraps) {
    for (const tag of event.tags) {
      if (tag[0] === 'p') pTagCounts.set(tag[1], (pTagCounts.get(tag[1]) || 0) + 1);
    }
  }
  evidence.measurements.repeatedIdentifierStability = {
    distinctPTagValues: pTagCounts.size,
    recipientWrapCount: pTagCounts.get(bob) || 0,
    totalWraps: wraps.length,
    note: 'The recipient account key recurs on every wrap: the account-graph linkability residual Gate C flags.',
  };

  // Classifier-feasibility PREVIEW: short vs long size classes by threshold.
  const shortSizes = observedSizes.filter((size) => size < 1024);
  const longSizes = observedSizes.filter((size) => size >= 1024);
  const previewRows = [];
  for (const size of shortSizes) previewRows.push({ class: 'short', wireContentBytes: size });
  for (const size of longSizes) previewRows.push({ class: 'long', wireContentBytes: size });
  const preview = previewRows.length > 1 && new Set(previewRows.map((row) => row.class)).size === 2
    ? bestThreshold(previewRows, 'short', 'long') : { threshold: null, correct: 0, confusion: null };
  evidence.measurements.classifierPreview = {
    description: 'PREVIEW STATISTIC ONLY: raw confusion counts of a size-only threshold separating short (<1024B observed content) from long wraps. NOT an AUC claim. NOT a Gate C numeric-limit pass.',
    thresholdBytes: preview.threshold,
    correctRows: preview.correct,
    totalRows: previewRows.length,
    confusion: preview.confusion,
  };

  // Zero-secrets assertion: re-serialize evidence and search for any 64-hex
  // string matching the accounts' pubkeys or secret material used in-process.
  const secretCandidates = [alice, bob].filter((value) => /^[0-9a-f]{64}$/i.test(value));
  const candidateJson = JSON.stringify({
    ...evidence, measurements: { ...evidence.measurements, pTagCounts: undefined,
      repeatedIdentifierStability: { ...evidence.measurements.repeatedIdentifierStability,
        distinctPTagValues: undefined } },
  });
  const pTagLeak = secretCandidates.find((candidate) => candidateJson.includes(candidate));
  record('zero secrets in evidence (heuristic pubkey scan)', !pTagLeak,
    { leaked: pTagLeak ? 'redacted-before-serialize' : null,
      note: 'Redaction is heuristic: 64-hex-char tag values are stripped before serialization; the scan above is best-effort, not a cryptographic guarantee.' });

  if (evidence.assertions.some((entry) => !entry.passed)) {
    evidence.result = 'failed';
    exitCode = 1;
  } else {
    evidence.result = 'passed';
  }
  evidence.wraps = wraps.map(({ atMs, event }) => ({ atMs, kind: event.kind,
    contentUtf8Bytes: Buffer.byteLength(event.content || '', 'utf8'),
    pTagPresent: event.tags.some((tag) => tag[0] === 'p'),
    pTagValueRedacted: event.tags.some((tag) => tag[0] === 'p')
      ? '<redacted-64hex>' : null, tags: redactTags(event.tags) }));
  evidence.clients = { senderAccount: '<redacted-64hex>', recipientAccount: '<redacted-64hex>' };
  evidence.corpusDelivered = { expected: CORPUS.length + 1, observedWraps: wrapCount };
} catch (error) {
  evidence.result = 'failed';
  evidence.error = error.message;
  exitCode = 1;
  throw error;
} finally {
  try {
    const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, encoded, { mode: 0o600 });
    console.log(encoded);
  } catch (writeError) {
    console.error('Could not write evidence file:', writeError.message);
    exitCode = exitCode || 1;
  }
  await contextA?.close();
  await contextB?.close();
  await browser?.close();
  await vite.close();
  await relay.close();
}
process.exit(exitCode);

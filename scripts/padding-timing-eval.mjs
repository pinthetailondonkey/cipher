// Padding/timing measurement harness (plan item 11 / gameplan "Timing/size
// resistance" row and Gate C). Read-only comparison against the legacy 640
// JS code unit padding helper in src/lib/giftWrap.js (padRumorContent); this
// script re-implements that helper's length math for measurement ONLY and
// imports nothing that mutates production paths.
//
// Outputs a deterministic JSON summary to stdout; the large per-message rows
// are written ONLY into $JCODE_SCRATCH_DIR.
import { TextEncoder } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { padToBucket, unpadFromBucket, PAD_HEADER_LEN } from '../src/lib/privacyMetrics/padBytes.js';

const RUMOR_PAD_TARGET_BYTES = 640;
const encoder = new TextEncoder();

// Deterministic PRNG (xorshift128+) so every run produces identical output.
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    // xorshift-ish via hashing for simplicity and determinism.
    s = (s * 1664525 + 1013904223) >>> 0;
    const x = ((s ^ (s >>> 15)) * 2246822519) >>> 0;
    return x / 0x100000000;
  };
}
const rng = makeRng(20261110);

// ── Legacy 640 JS-code-unit helper, re-implemented read-only for measurement ──
// From giftWrap.js padRumorContent: pad rides INSIDE an object body as a
// JSON field so the whole body is exactly target code units. For bodies that
// are not parseable JSON objects it returns text unchanged. The measured wire
// byte count is UTF-8 bytes of the padded string.
function legacyPadCodeUnits(text) {
  const deficit = RUMOR_PAD_TARGET_BYTES - text.length;
  if (deficit <= 0) return text;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text;
    if ('pad' in parsed && parsed.pad !== undefined) return text;
    const budget = deficit - ',"pad":""'.length;
    if (budget < 1) return text;
    return JSON.stringify({ ...parsed, pad: 'x'.repeat(Math.max(0, budget)) });
  } catch {
    return text;
  }
}

// ── Synthetic corpus across realistic activity classes ───────────────────────
// Sizes chosen to straddle the 512-byte ladder base and the legacy 640-unit
// rung so both schemes' quantization is exercised. Text content is synthetic:
// no real user data, generated deterministically at runtime.

const WORDS = ['order', 'receipt', 'thanks', 'please', 'confirm', 'address', 'sent', 'received',
  'monero', 'bitcoin', 'listing', 'refund', 'shipping', 'total', 'price', 'tomorrow'];

function synthText(targetChars) {
  let words = [];
  while (words.join(' ').length < targetChars) {
    words.push(WORDS[Math.floor(rng() * WORDS.length)]);
  }
  return words.slice(0, Math.ceil(targetChars / 7)).join(' ').slice(0, targetChars);
}

const CLASSES = [
  { name: 'chat-short', min: 20, max: 120 },
  { name: 'chat-medium', min: 200, max: 600 },
  { name: 'chat-long', min: 800, max: 2400 },
  { name: 'order-payload', min: 300, max: 1600 },
  { name: 'receipt', min: 120, max: 900 },
];
const PER_CLASS = 60; // half train, half held-out

function buildCorpus() {
  const corpus = [];
  for (const cls of CLASSES) {
    for (let i = 0; i < PER_CLASS; i += 1) {
      const span = cls.max - cls.min;
      const size = Math.floor(cls.min + (i / PER_CLASS) * span + (rng() - 0.5) * span * 0.1);
      corpus.push({ class: cls.name, plaintext: synthText(Math.max(cls.min, Math.min(cls.max, size))) });
    }
  }
  return corpus;
}

// Wrap-size model: the legacy wire is a NIP-59 wrap whose ciphertext length
// tracks the rumor body's byte length. We model wrap overhead as a fixed
// 3265-byte floor observed on the live path (plan §1: 3,265 bytes measured)
// plus the body bytes. This is a wire-class model for comparison, not a
// claim about exact production bytes.
const WRAP_OVERHEAD_BYTES = 3265;

// Legacy padded wire bytes for one message: if the padded body collides with
// our object shape, we simulate a {"m": "...", } body of the same char count.
function legacyWire(text) {
  const body = JSON.stringify({ m: text });
  const padded = legacyPadCodeUnits(body);
  const paddedUtf8 = encoder.encode(padded).length;
  return { paddedBodyChars: padded.length, wireBytes: WRAP_OVERHEAD_BYTES + paddedUtf8 };
}

function ladderWire(text, topBucketBytes) {
  // Rebuild from actual text so the strip-check is honest:
  const raw = encoder.encode(text);
  const paddedReal = padToBucket(raw, { topBucketBytes });
  const stripped = unpadFromBucket(paddedReal);
  if (!stripped || Buffer.compare(Buffer.from(stripped), Buffer.from(raw)) !== 0) {
    throw new Error(`Ladder round-trip failed for ${text.length}-char payload.`);
  }
  return { bucket: paddedReal.length, wireBytes: WRAP_OVERHEAD_BYTES + paddedReal.length };
}

// ── Held-out classifier (AUC), size-only features ─────────────────────────────
// Features per observation: the relay-visible quantity(s). For baseline we use
// the unpadded body byte length; after padding we use only the wire bucket.
// Train/test split: even indices train, odd indices held out, stratified by
// class. Classifier: per-feature Gaussian naive Bayes ranking each class,
// AUC computed one-vs-rest by pairwise rank counting (Mann-Whitney U).

function meanVar(xs) {
  const n = xs.length;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / n;
  return [m, v + 1e-9];
}

function logPdf(x, m, v) {
  return -0.5 * Math.log(2 * Math.PI * v) - (x - m) ** 2 / (2 * v);
}

function evaluate(rows) {
  // rows: [{cls (index), feature}]
  const train = rows.filter((_, i) => i % 2 === 0);
  const test = rows.filter((_, i) => i % 2 === 1);
  const models = new Map();
  for (let c = 0; c < CLASSES.length; c += 1) {
    const feats = train.filter((r) => r.cls === c).map((r) => r.feature);
    models.set(c, meanVar(feats));
  }
  const flat = test.map((r) => ({ cls: r.cls, feature: r.feature }));
  let aucs = [];
  for (let c = 0; c < CLASSES.length; c += 1) {
    const pos = flat.filter((r) => r.cls === c);
    const neg = flat.filter((r) => r.cls !== c);
    if (!pos.length || !neg.length) continue;
    // feature likelihood-ratio margin: pos class pdf vs max over others
    const marginFor = (feat, expect) => {
      const [m1, v1] = models.get(expect);
      const l_self = logPdf(feat, m1, v1);
      let l_other = -Infinity;
      for (const [o, mv] of models.entries()) {
        if (o === expect) continue;
        const lo = logPdf(feat, mv[0], mv[1]);
        if (lo > l_other) l_other = lo;
      }
      return l_self - l_other;
    };
    let wins = 0;
    let pairs = 0;
    for (const p of pos) {
      for (const n of neg) {
        pairs += 1;
        const dp = marginFor(p.feature, c);
        const dn = marginFor(n.feature, c);
        if (dp > dn) wins += 1;
        else if (dp === dn) wins += 0.5;
      }
    }
    aucs.push(wins / pairs);
  }
  return aucs.reduce((a, b) => a + b, 0) / aucs.length;
}

// ── Run ──────────────────────────────────────────────────────────────────────
const TOP_BUCKET = 8192;

function main() {
  const scratch = process.env.JCODE_SCRATCH_DIR || mkdtempSync(join(tmpdir(), 'padding-eval-'));
  const corpus = buildCorpus();

  const baselineRows = [];
  const ladderRows = [];
  const perMessage = [];
  let sumLegacy = 0;
  let sumLadder = 0;
  let sumRawPlain = 0;
  let p95Delays = [];

  corpus.forEach((msg, index) => {
    const raw = msg.plaintext;
    const rawBytes = encoder.encode(raw).length;
    const legacy = legacyWire(raw);
    const ladder = ladderWire(raw, TOP_BUCKET);
    // Padding fill delay model: sending a padded frame costs zero additional
    // wait itself; but under batched dispatch the filler adds transmission
    // time proportional to its bytes on a link. Report fill as fraction of
    // bucket wasted plus modeled transmission delay at 1 Mbps loopback-free
    // reference link (bytes * 8 / 1_000_000 s).
    const fillBytes = ladder.bucket - PAD_HEADER_LEN - rawBytes;
    void fillBytes;
    const fillDelayMs = (ladder.wireBytes - (WRAP_OVERHEAD_BYTES + rawBytes)) * 8 / 1000;
    p95Delays.push(fillDelayMs);

    baselineRows.push({ cls: CLASSES.findIndex((c) => c.name === msg.class), feature: rawBytes });
    ladderRows.push({ cls: CLASSES.findIndex((c) => c.name === msg.class), feature: ladder.bucket });

    sumLegacy += legacy.wireBytes;
    sumLadder += ladder.wireBytes;
    sumRawPlain += rawBytes;
    perMessage.push({
      index, class: msg.class, plaintextBytes: rawBytes, plaintextChars: raw.length,
      legacyPaddedBodyChars: legacy.paddedBodyChars, legacyWireBytes: legacy.wireBytes,
      ladderBucketBytes: ladder.bucket, ladderWireBytes: ladder.wireBytes,
      ladderOverheadRatio: +(ladder.wireBytes / (WRAP_OVERHEAD_BYTES + rawBytes)).toFixed(3),
      fillDelayMs: +fillDelayMs.toFixed(4),
    });
  });

  const aucBaseline = evaluate(baselineRows);
  const aucLadder = evaluate(ladderRows);
  p95Delays.sort((a, b) => a - b);
  const p95 = p95Delays[Math.floor(p95Delays.length * 0.95) - 1] ?? p95Delays[p95Delays.length - 1];

  const summary = {
    schema: 'padding-timing-eval-v1',
    deterministicSeed: 20261110,
    corpus: { classes: CLASSES.map((c) => c.name), messagesPerClass: PER_CLASS, totalMessages: corpus.length },
    schemes: {
      legacy: { description: 'giftWrap.js-style 640 JS code units, single rung, no op beyond one rung', target: RUMOR_PAD_TARGET_BYTES },
      ladder: { description: `byte power-of-two ladder from 512B, top bucket ${TOP_BUCKET}B`, base: 512, top: TOP_BUCKET },
    },
    results: {
      aucRouteInference: {
        baselineUnpaddedSizeFeature: +aucBaseline.toFixed(4),
        afterByteLadderPadding: +aucLadder.toFixed(4),
        relativeImprovementPct: +(((aucBaseline - aucLadder) / aucBaseline) * 100).toFixed(2),
        draftThreshold: '<= 0.55 single relay / <= 0.65 two hops',
      },
      bytesPerLogicalMessage: {
        baselineWireAvg: +(sumLegacy / corpus.length).toFixed(1),
        ladderWireAvg: +(sumLadder / corpus.length).toFixed(1),
        rawPlaintextAvg: +(sumRawPlain / corpus.length).toFixed(1),
        ladderVsBaselineRatio: +(sumLadder / sumLegacy).toFixed(3),
        draftThreshold: 'corpus-average wire bytes <= 2x baseline',
      },
      delay: {
        p95ModelledFillDelayMs: +p95.toFixed(3),
        modelNote: 'fill transmitted once at reference 1 Mbps; draft p95 delivery threshold <= 3s includes batching which is NOT modelled here',
      },
    },
    scratchDir: scratch,
  };

  writeFileSync(join(scratch, 'padding-timing-per-message.json'), JSON.stringify(perMessage, null, 1));
  writeFileSync(join(scratch, 'padding-timing-summary.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main();

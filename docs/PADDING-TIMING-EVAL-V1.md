# PADDING-TIMING-EVAL-V1

DRAFT PENDING REVIEWER RATIFICATION. This document proposes thresholds; it
ratifies nothing. All numbers below are measured on this working tree with the
commands recorded, using a synthetic corpus. They are not release evidence.

Status: partial, web-forwarder evidence pending two-operator tests (plan item
10 requires that exact label).

## What was measured and how

Commands run in `/home/aegis/cipher`:

```
node scripts/padding-timing-eval.mjs        # exit 0
node scripts/forwarder-perhop-test.mjs      # exit 0, pass: true
npx oxlint src/lib/privacyMetrics/padBytes.js scripts/padding-timing-eval.mjs \
  scripts/forwarder/wsFraming.mjs scripts/forwarder/entryForwarder.mjs \
  scripts/forwarder/mailboxCapture.mjs scripts/forwarder-perhop-test.mjs
# Found 0 warnings and 0 errors.
```

The eval harness builds a deterministic synthetic corpus of 300 messages
across five activity classes (chat-short, chat-medium, chat-long,
order-payload, receipt; 60 each). For every message it measures wire bytes
under two padding schemes:

- Legacy: the giftWrap.js 640 JS code unit helper re-implemented for
  measurement only (read-only comparison; production path untouched).
- Byte ladder (new `src/lib/privacyMetrics/padBytes.js`): UTF-8 byte
  power-of-two buckets from 512 B, top bucket 8192 B, applied before
  encryption with a 4-byte v1 header carrying scheme version, ladder shift,
  and plaintext length.

Wrap overhead is modeled as a fixed 3265-byte floor observed on the live NIP-59
path plus the padded body bytes. This is a wire-class model for comparing
schemes, not an exact production capture.

Held-out classifier evaluation: Gaussian naive-Bayes likelihood-ratio margins
on size-only features; even-index messages train, odd-index held out; one-vs-
rest AUC by Mann-Whitney rank counting over all class pairs.

## Proposed draft thresholds (from docs/PRIVACY-PROTOCOL-GAMEPLAN.md Gate C)

All values below are DRAFT PENDING REVIEWER RATIFICATION. Reviewers must
ratify or replace them with reasons and measurable bounds before prototype
implementation claims or any release gate.

| Metric | Draft limit | Measured here |
|---|---|---|
| Route-to-activity inference AUC (single relay) | <= 0.55 | 0.7408 after ladder padding |
| Route-to-activity inference AUC (two colluding hops) | <= 0.65 | not measured; no two-operator test |
| Classifier improvement vs baseline | >= 25% relative | 17.85% |
| p95 delivery delay | <= 3 s | 7.976 ms modeled fill-only component |
| Corpus-average wire bytes | <= 2x baseline | 1.051x |

Measured summary (full JSON printed by the eval script; per-message rows in
$JCODE_SCRATCH_DIR only):

- baseline size-feature AUC 0.9017, after ladder padding 0.7408.
- baseline avg wire 4175.7 B/message, ladder avg 4388 B, raw plaintext avg
  699.9 B.
- Modeled fill transmission delay at a 1 Mbps reference link: p95 7.976 ms.
  Real batching wait is NOT modeled; the <= 3 s draft target includes it.

## Honest limitations

1. Synthetic corpus. Sizes mimic chat, order and receipt classes but text is
   generated from a fixed word list; real user traffic may have different
   size distributions, cross-class correlations and burst structure.
2. Wire-size model. The 3265-byte wrap overhead is a single observed figure,
   not a distribution across payload sizes, kinds, tag counts or NIP-44
   internal bucketing. Absolute wire numbers are indicative, not captures.
3. Classification is deliberately weak. One feature (size), naive-Bayes
   margins, half split. A competent adversary would use timing sequences,
   inter-message intervals, event counts and content-aware priors, so the
   measured AUC understates adversarial capability against the same wire.
4. The ladder does not meet the draft AUC limits as measured (0.7408 vs
   0.55 / 0.65 drafts; 17.85% improvement vs >= 25% draft). The measured pass
   applies only to the bytes ratio and fill-delay rows. This is reported, not
   reconciled; ratifying reviewers decide whether to raise top buckets, add
   randomized batching/decoy traffic (measured separately per Gate C), or
   replace the thresholds.
5. Delay evidence excludes batching wait, relay latency, TLS/Tor overhead and
   queue effects. It covers only padding-fill transmission time.
6. Forwarder prototype is loopback-only: simulated-origin -> entry forwarder
   -> mailbox capture relay, all in one process host, Node 20 raw-TCP
   WebSocket framing, no npm dependencies added. It shows the mailbox sees
   the forwarder's listening socket identity (per-hop log lines assert
   loopback source and that the origin's original source port never appears).
   It does not show multi-network, multi-operator anonymity, Tor reachability,
   browser WebSocket behavior, or correlation resistance between operators.
   Label stands: partial, web-forwarder evidence pending two-operator tests.
7. No production file was modified. padBytes.js has no app caller yet;
   integration into the encrypted path before sealing is a separate step with
   its own review.

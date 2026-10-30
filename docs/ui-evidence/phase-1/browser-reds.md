# The 14 browser reds, named and classified

Measured twice, at two different trees, with the identical failing titles:

- `logs/test-7dba504-6004c14.log` is the node suite and says **851/851 green** — it says nothing about these.
- `/tmp/p1-full-ui.log`: full Playwright run, 121 tests, **107 passed / 14 failed**, tree `6004c14f`, 27.4m.
- `/tmp/base-4c2b616-red.log`: the same four spec files at base `4c2b616`, **14 failed / 5 passed**, 12.9m.

The identical titles at the base are what makes these pre-existing: none of them is a Phase 1 regression.

Verdicts are `stale spec`, `environment`, or `product bug`. Anything not yet measured says so instead of guessing.

| # | Spec | Verdict | One-line reason |
|---|---|---|---|
| 1 | `passkey-recovery-commit.spec.js:73` | **stale spec** | asserts the sentence "A saved passkey is ready for future unlocks." — that string exists nowhere in `src/`; what ships is `src/components/chat/IdentityBackup.jsx:110`: "A saved passkey opens this account on this device from now on. It does not replace the 12 words." |
| 2 | `persistence.spec.js:97` (fails at :186) | **stale spec** | waits for `getByRole('button',{name:'Open menu'})` after reload; the boot screen is Chats, whose header door is "Chat list menu" |
| 3 | `persistence.spec.js:328` | **stale spec** | same landmark wait, `:342` |
| 4 | `sheet-a11y.spec.js:65` Saved viewer | **stale spec** | beforeEach waits for "Open menu" (`:17-20`); the app boots to Chats, which has "Chat list menu" |
| 5 | `sheet-a11y.spec.js:76` Saved viewer, focus return | **stale spec** | same beforeEach |
| 6 | `sheet-a11y.spec.js:65` Notifications center | **stale spec** | same beforeEach |
| 7 | `sheet-a11y.spec.js:76` Notifications center, focus return | **stale spec** | same beforeEach |
| 8 | `sheet-a11y.spec.js:65` QR scanner | **stale spec** | same beforeEach |
| 9 | `sheet-a11y.spec.js:76` QR scanner, focus return | **stale spec** | same beforeEach |
| 10 | `sheet-a11y.spec.js:65` How to use (tutorial) | **stale spec** | same beforeEach |
| 11 | `sheet-a11y.spec.js:76` How to use (tutorial), focus return | **stale spec** | same beforeEach |
| 12 | `sheet-a11y.spec.js:96` New group sheet | **stale spec** | same beforeEach |
| 13 | `sheet-a11y.spec.js:110` Escape with no sheet open | **stale spec** | same beforeEach (it asserts no page error, which needs no landmark, so this one is a fixture-cost red, not a behaviour red) |
| 14 | `txid-single.spec.js:135` control: a confirmed answer writes a receipt once | **environment (contention)** — measured, see below | alone on a quiet box at `9f9644a` it passes 4/4 in 1.1m with `--trace on`; the control trace carries neither `[orders] Chain check failed:` nor `[payments] Watcher did not answer:`, while both refusal siblings do log the former. The red at `6004c14` ran under 121 parallel browser tests on two cores and carried a separate `Test timeout of 30000ms exceeded`. |

## What the boot landmark proves, and what it does not

For reds 2–13 the failure is the same line: `getByRole('button', { name: 'Open menu' })` is not on screen after boot. The failure snapshot shows the app fully rendered on **Chats** — header reads "Chat list menu", list and tab bar drawn. The old shell's "Open menu" door (`src/AuthenticatedApp.jsx:176`, `md:hidden`) is not what the Chats screen mounts any more; `ChatList.jsx` draws its own header with "Chat list menu".

So the specs are asserting a landmark that the shipping shell no longer puts on the boot screen. The surfaces those specs mean to test (Saved viewer, Notifications, QR scanner, tutorial) are still reachable from "Chat list menu" — the spec's own comment at `sheet-a11y.spec.js:26-28` says the doors "moved into the list header's kebab", but the `beforeEach` landmark was left behind.

The removal was deliberate, and the repo already says so: `src/components/chat/chatList.test.js:304` asserts `labelledButton(hosts, 'Open menu')` is `undefined` — "the phone drawer door is gone from the chat header" — and asserts "Chat list menu" is the one overflow on the left. So the twelve browser specs are waiting on a control the app removed on purpose, and a green unit test in the same tree pins its absence.

A stale landmark is not a licence to change the tests: these are someone else's specs, they sit outside this phase, and rewriting a suite to go green is exactly what the standing rules forbid. They are recorded here so the number 14 has names attached to it.

## The one that was not closed — now measured

`txid-single.spec.js:135` is the control for a payment receipt. It was red at both trees in the full runs, in the `[iphone]` project, on a box running 121 browser tests in parallel on two cores. Its failure detail was at line 148 (`expect.poll` over `_receipt_` keys, Expected true / Received false) and **the same block carried a separate `Test timeout of 30000ms exceeded`** — the whole test was time-starved, not the poll alone.

It was kept UNCLASSIFIED until a quiet, single-spec run measured it, because the refusal siblings are not a control: the control is the only one of the three that reaches the state machine, the identity guard, the ledger read and the Web Lock, and the two refusals throw before any of them.

That run has now happened:

- Command: `AUD_HARNESS_PORT=8081 npx playwright test tests/ui/txid-single.spec.js --project=iphone --trace on --workers=1`
- Logs: `logs/txid-single-9f9644a-38cd58e.log` (first run) and
  `logs/txid-single-9f9644a-38cd58e-run2.log` (the run whose traces below are
  durable). Both: 4 passed (1.1m), exit 0.
- Traces, copied out of `test-results/` before anything could clean it:
  `logs/traces-9f9644a-38cd58e/*.zip` — four zips, one per test, each named for
  its test directory. A later `playwright test` deletes `test-results/` at
  startup, which is how the first run's traces were lost; the copy is what
  makes this table checkable.
- Tree: sha `9f9644abb9c519ac710e21e104c4c2f3fd24b567`, tree `38cd58e74f0099ff234cca88428c16f599707013`; run-context recorded `sha=9f9644a… port=8081 assets=13`, `dirty=true` (the only working-tree difference from `HEAD` is this evidence directory — no source file differs).

The ordered trace grep, run inside `logs/traces-9f9644a-38cd58e/`:

| Test (trace zip) | File | `[orders] Chain check failed:` | `[payments] Watcher did not answer:` |
| --- | --- | --- | --- |
| control `:135` (`txid-single-a-report-names-5294f-…-receipt-once-iphone.zip`) | `1-trace.trace`, `0-trace.trace` | **absent** | **absent** |
| refusal two txids `:156` (`…-7f533-…-moves-no-order-iphone.zip`) | `1-trace.trace` **line 165** | **present** — `The watcher did not name a single transaction. Nothing was marked on the order.` | absent |
| refusal numeric txid `:172` (`…-c5530-…-writes-no-receipt-either-iphone.zip`) | `1-trace.trace` **line 158** | **present** — same line | absent |
| run-context setup (`runContext.setup.js-…zip`) | `test.trace`, `0-trace.trace` | absent | absent |

Zip sha256 (so a reader can prove the trace they hold is the one measured):
control `51a730ee…`; refusal `:156` `3a526b1e…`; refusal `:172` `237b5d07…`;
run-context `05c75adc…` (full values via `sha256sum` on the directory).

The two present hits are the refusals' own designed path (the fixture's answer is refused, and the refusal is logged before anything is written); they prove the grep can see the line it is looking for. The control's trace carries neither line in any of its streams, so its pass is not a stall and not a swallowed throw: the watcher answered, the chain check passed, and the receipt was written. The test's own assertions agree — `asked.length === 1`, a `_receipt_` key exists, and the ledger entry count rises.

**Verdict: environment (contention).** The red is a 30s-test-budget failure on a two-core box running 121 browser tests in parallel, not a defect in the confirm→receipt write. Two limits are stated rather than smoothed over:

- the quiet run is at `9f9644a`, not at `6004c14` where the red was first seen; it measures the shipping tree, which is what a launch signature needs, and does not re-try the older tree alone;
- `--workers=1` is one test at a time by construction, so this run cannot reproduce parallel contention by design. It rules out the money-path defect the red could have been; it does not prove the 121-test scheduling is healthy.

Nothing in the spec or the app was edited for this verdict.

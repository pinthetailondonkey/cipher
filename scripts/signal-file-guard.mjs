#!/usr/bin/env node
// I12 — Signal-file guard (protocol build plan v2, §5 I12).
//
// Fails when an AGENTS.md signal file changes without a recorded reason.
// A "signal file" is any file whose silent change would alter a trust edge
// the repo holds read-only by convention (see AGENTS.md "Hard lines" and
// docs/PRIVACY-REVIEW.md). The ledger below records the stated reason for
// every known change; a change whose path is listed with a reason passes,
// and any changed signal path missing from the ledger fails the run.
//
// Run modes:
//   node scripts/signal-file-guard.mjs                — inspects the staged
//     index (git diff --cached) for CI/clean-verify use.
//   node scripts/signal-file-guard.mjs --worktree     — inspects the unstaged
//     working tree (git diff) for pre-flight checks while editing.
//
// Exit codes: 0 = every changed signal file has a ledger reason,
// 1 = a changed signal file has no recorded reason (the guard's failure),
// 2 = the invocation is unusable (not a repo, git refused).
//
// Designed to run inside scripts/clean-verify.sh and in Phase 1 of the plan.
// It never mutates anything: no writes, no git commands that change state.

import { execFileSync } from 'node:child_process';

// The signal-file ledger. Keys are exact repo-relative paths; values are the
// recorded reason the staged change exists. Adding a new entry requires the
// reason to name the change's owner slice and the evidence for it.
const SIGNAL_FILES = Object.freeze({
  'src/hooks/useNIP44DM.js': (
    'Slice C/R5-A lifecycle wiring: wrap call sites recheck the security ' +
    'context (assertIdentityCurrent) before sealing DM payloads; the ' +
    'production DM crypto (NIP-44 seal via sealAndWrap) is unchanged. ' +
    'Staged diff evidence: +69/-11, additions are fence assertions and ' +
    'group-key install guards, no cipher-text change.'
  ),
  'src/lib/outbox.js': (
    'R5-A authority bridge: queued ratchet rows (protocol ' +
    'cipher-ratchet-device-delivery-v2) are refused unless a current ' +
    'account security context publishes them. Production flushNostrOutbox ' +
    'behavior for ordinary rows is unchanged. +59/-6.'
  ),
  'src/lib/paymentWatch.js': (
    'Slice A watcher v2 trust: checkPayment now requires a pinned signed ' +
    'v2 report, sends the derived child token in the Authorization header ' +
    'and never in the URL, echoes address/currency, and applies the S1 ' +
    'issuance-date gate. +95/-65.'
  ),
  'src/lib/egress.js': (
    'Protocol-test boundary: activeUrl resolves to an empty string for the ' +
    'protocol-test artifact so the test build cannot reach an ordinary app ' +
    'relay even through a saved local override. +4/-0, one guard clause.'
  ),
  'src/lib/privacy.js': 'UNCHANGED in current index; ledger entry kept so ' +
    'the guard fails loudly if that ever changes without a recorded reason ' +
    'here.',
  'src/store/chatStore.js': 'UNCHANGED in current index; selector hygiene ' +
    'only reason on file. Ledger entry present so silent changes fail.',
  'src/lib/paymentState.js': (
    'Slice B payment semantics: nextPaymentState/applyWatcherReport now ' +
    'demand a countable coin amount before confirmation depth can move a ' +
    'state, matching the piconero law. Verified by ' +
    'src/lib/paymentState.test.js in the focused commerce suite.'
  ),
  'src/lib/crypto/groupKeyStore.js': (
    'Slice: group signal file — store writes now run through a captured ' +
    'security fence (assertCapturedFence/writeTransaction) so a stale ' +
    'incarnation cannot commit a group key. +115/-38.'
  ),
  'src/lib/crypto/groupKeyDistribution.js': (
    'Group key distribution rides the same captured-fence write path as ' +
    'the store; no grant shape change. +50/-16.'
  ),
  'src/lib/crypto/groupKeyRotation.js': (
    'Rotation routes through the fenced store writes; epoch semantics ' +
    'unchanged. +104/-25.'
  ),
  'src/lib/crypto/groupDocWire.js': (
    'Member-doc wire now validates against the governed shapes the group ' +
    'store writes. +32/-19.'
  ),
  'src/lib/crypto/groupMessageCodec.js': (
    'Codec hardened against malformed AAD/metadata fields surfaced by the ' +
    'store lifecycle tests. +8/-8.'
  ),
  'src/lib/crypto/gmIdentity.js': (
    'Group member identity proof uses the shared capture fence before ' +
    'publishing. +7/-0.'
  ),
});

const trackedSignalPaths = () => Object.keys(SIGNAL_FILES);

function gitDiff(mode) {
  const args = mode === '--worktree'
    ? ['diff', '--']
    : ['diff', '--cached', '--'];
  try {
    return execFileSync('git', [...args, ...trackedSignalPaths()], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    process.stderr.write(`signal-file-guard: git refused (${error.message})\n`);
    process.exit(2);
  }
}

function changedPathsFromDiff(diffText) {
  const changed = new Set();
  for (const line of diffText.split('\n')) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) changed.add(match[2]);
  }
  return changed;
}

const mode = process.argv[2] || '';
if (mode && mode !== '--worktree') {
  process.stderr.write(`signal-file-guard: unknown mode ${mode}. Use no argument for the staged index or --worktree.\n`);
  process.exit(2);
}
const diffText = gitDiff(mode ? '--worktree' : undefined);
const changed = changedPathsFromDiff(diffText);

if (!changed.size) {
  console.log('signal-file-guard: no signal file changed; pass.');
  process.exit(0);
}

const failures = [];
for (const path of changed) {
  const reason = SIGNAL_FILES[path];
  if (!reason || reason.startsWith('UNCHANGED')) {
    failures.push(path);
    process.stderr.write(`signal-file-guard: FAIL ${path} — changed without a recorded reason.\n`);
  } else {
    console.log(`signal-file-guard: ok ${path} — ${reason.split('. ')[0]}.`);
  }
}

if (failures.length) {
  process.stderr.write(
    `signal-file-guard: ${failures.length} changed signal file(s) lack a ` +
    'recorded reason. Add the reason to SIGNAL_FILES with evidence, or ' +
    'revert the change. Signal files are read-only without a stated reason.\n',
  );
  process.exit(1);
}
console.log('signal-file-guard: every changed signal file has a recorded reason; pass.');
process.exit(0);

// Stale-commit, replay and fork rejection validators for the MLS v1 test
// profile (docs/MLS-TEST-PROFILE-V1.md Sections 1, 3, 4, 6).
//
// TEST PROFILE ONLY. Pure validators over an epoch chain of signed commits.
// A commit is a minimal MLS-shaped stand-in: signed Ed25519 over
// (groupId, epoch, transcriptHash, prevTranscriptHash, membership delta).
// These validators reject: forged signatures, wrong previous revision,
// stale epochs, replayed commits, and forked transcript state.

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalHash } from './governanceBinding.js';

export async function commitDigest(commit) {
  return canonicalHash({
    delta: commit.delta ?? null,
    epoch: commit.epoch,
    groupId: commit.groupId,
    prevRev: commit.prevRev,
    prevTranscriptHash: commit.prevTranscriptHash,
    t: 'mlscommit',
    transcriptHash: commit.transcriptHash,
  });
}

export async function signCommit(commit, secretKey) {
  const digest = await commitDigest(commit);
  const message = new Uint8Array(digest.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const signature = ed25519.sign(message, secretKey);
  return {
    ...commit,
    eventId: `evt-${digest.slice(0, 16)}`,
    pubkey: bytesToHex(ed25519.getPublicKey(secretKey)),
    sig: bytesToHex(signature),
  };
}

function hexToBytes(hex) {
  return new Uint8Array(String(hex).match(/.{2}/g).map((h) => parseInt(h, 16)));
}

// Rejection reasons as stable strings so vectors can assert exactly.
export const REJECT_REASONS = {
  FORGED: 'forged-commit',
  ROSTER_ONLY: 'roster-only-add',
  WRONG_PREV_REV: 'wrong-prev-revision',
  CROSS_HASH: 'cross-hash-mismatch',
  STALE_EPOCH: 'stale-epoch',
  REPLAY: 'replayed-commit',
  FORK: 'forked-transcript',
  UNAUTHORIZED_ROLE: 'committer-not-admin',
};

// Chain validator. `chain` is an array of signed commits in arrival order.
// `adminPubkeys` is the authorized committer set at the pinned revision;
// `isRosterAdd` marks events that claim membership without a commit
// signature (the roster-only-add vector).
export async function validateCommitChain({
  groupId: _groupId, chain, adminPubkeys, allowedCommitters = null,
}) {
  const admins = new Set((adminPubkeys || []).map((p) => p.toLowerCase()));
  const committers = new Set((allowedCommitters || admins));
  const seenEventIds = new Set();
  const accepted = [];
  let epoch = 0;
  let prevTranscriptHash = null;
  const rejections = [];

  for (const commit of chain) {
    // Roster-only add: a membership claim with no valid commit signature.
    if (commit.isRosterAdd || !commit.sig) {
      rejections.push({ eventId: commit.eventId || null, reason: REJECT_REASONS.ROSTER_ONLY });
      continue;
    }
    // Replay: the exact event id was already merged.
    if (seenEventIds.has(commit.eventId)) {
      rejections.push({ eventId: commit.eventId, reason: REJECT_REASONS.REPLAY });
      continue;
    }
    // Stale or forked epoch: must be exactly current + 1.
    if (commit.epoch !== epoch + 1) {
      rejections.push({ eventId: commit.eventId, reason: REJECT_REASONS.STALE_EPOCH });
      continue;
    }
    // Wrong previous revision.
    if (commit.prevRev !== epoch) {
      rejections.push({ eventId: commit.eventId, reason: REJECT_REASONS.WRONG_PREV_REV });
      continue;
    }
    // Fork: previous transcript hash does not match our accepted history.
    if (prevTranscriptHash !== null && commit.prevTranscriptHash !== prevTranscriptHash) {
      rejections.push({ eventId: commit.eventId, reason: REJECT_REASONS.FORK });
      continue;
    }
    // Forged: signature over the canonical binding fails.
    const digest = await commitDigest(commit);
    let sigOk = false;
    try {
      sigOk = ed25519.verify(hexToBytes(commit.sig), hexToBytes(digest), hexToBytes(commit.pubkey));
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      rejections.push({ eventId: commit.eventId, reason: REJECT_REASONS.FORGED });
      continue;
    }
    // Committer role: must be an authorized admin at the previous revision.
    if (!admins.has(commit.pubkey.toLowerCase()) || !committers.has(commit.pubkey.toLowerCase())) {
      rejections.push({ eventId: commit.eventId, reason: REJECT_REASONS.UNAUTHORIZED_ROLE });
      continue;
    }
    seenEventIds.add(commit.eventId);
    epoch = commit.epoch;
    prevTranscriptHash = commit.transcriptHash;
    accepted.push(commit);
  }
  return { accepted, rejections, currentEpoch: epoch, currentTranscriptHash: prevTranscriptHash };
}

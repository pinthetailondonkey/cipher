// Receiver buffering state machine for the MLS v1 test profile
// (docs/MLS-TEST-PROFILE-V1.md Section 6).
//
// TEST PROFILE ONLY. A receiver grants no key use until BOTH the MLS commit
// event and the next governance document verify. Until then it buffers.
// Verification failure reasons come from commitValidators.REJECT_REASONS.

import { verifyCommitGovernance } from './governanceBinding.js';

export const STATES = {
  BUFFERING: 'BUFFERING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
  FROZEN: 'FROZEN',
};

export function createReceiverStateMachine({ groupId: _groupId } = {}) {
  let state = STATES.BUFFERING;
  let pendingCommit = null;
  let pendingGovernance = null;
  let bufferedEvents = [];
  let rejections = [];

  const machine = {
    get state() { return state; },
    get buffered() { return [...bufferedEvents]; },
    get rejections() { return [...rejections]; },
    get pendingCommit() { return pendingCommit; },
    get pendingGovernance() { return pendingGovernance; },

    // Feed one event. Types: 'commit' or 'governance'.
    receive(type, event) {
      if (state === STATES.FROZEN || state === STATES.REJECTED) {
        bufferedEvents.push({ type, receivedAt: Date.now(), event });
        return state;
      }
      if (type === 'commit') {
        if (pendingCommit) {
          rejections.push({ reason: 'conflicting-commit', type });
          state = STATES.REJECTED;
        } else {
          pendingCommit = event;
        }
      } else if (type === 'governance') {
        if (pendingGovernance) {
          rejections.push({ reason: 'conflicting-governance', type });
          state = STATES.REJECTED;
        } else {
          pendingGovernance = event;
        }
      } else {
        rejections.push({ reason: 'unknown-event-type', type });
      }
      return state;
    },

    // Attempt to verify the buffered pair. Both must pass or nothing does.
    async tryVerify() {
      if (!pendingCommit || !pendingGovernance) return state;
      const extension = pendingCommit.governanceExtension;
      const checked = await verifyCommitGovernance({
        extension,
        commitHashBinding: pendingCommit.commitHashBinding,
        governanceDoc: pendingGovernance,
        signerActor: pendingCommit.signerActor,
      });
      if (!checked) {
        rejections.push({ reason: 'pair-verification-failed', type: 'pair' });
        state = STATES.REJECTED;
        return state;
      }
      if (pendingGovernance.nextRefs
        && pendingGovernance.nextRefs.commitHash !== pendingCommit.commitHashBinding) {
        rejections.push({ reason: 'cross-hash-mismatch', type: 'pair' });
        state = STATES.REJECTED;
        return state;
      }
      state = STATES.VERIFIED;
      return state;
    },

    // Cross-relay attestation mismatch freezes the group outright.
    freeze({ reason }) {
      rejections.push({ reason: reason || 'equivocation', type: 'freeze' });
      state = STATES.FROZEN;
      return state;
    },

    reject(reason) {
      rejections.push({ reason, type: 'explicit' });
      state = STATES.REJECTED;
      return state;
    },
  };
  return machine;
}

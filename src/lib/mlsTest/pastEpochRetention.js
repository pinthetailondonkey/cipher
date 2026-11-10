// Past-epoch retention enforcement wrapper for the MLS v1 test profile
// (docs/MLS-TEST-PROFILE-V1.md Section 4, plan item 16).
//
// TEST PROFILE ONLY. Wraps an MLS-shaped state object and destroys (not
// hides) old-epoch keys once the epoch moves beyond the retention window.
// The default window is 4 past epochs. After a wipe, decryption of an
// out-of-window epoch must fail, not fall back to a stale key.

import { canonicalHash } from './governanceBinding.js';

export const PAST_EPOCH_RETENTION = 4;

// Wrapper over a map of epoch -> sealed key material. `wipe` simulates the
// OpenMLS past-epoch trim; the real setting name is still unverified
// (reviewer-open point in the spec).
export function createRetentionWrapper({ retention = PAST_EPOCH_RETENTION, now = () => Date.now() } = {}) {
  const keys = new Map(); // epoch -> key material
  let currentEpoch = 0;
  let lastActivity = 0;

  return {
    retention,
    get currentEpoch() { return currentEpoch; },
    setKey(epoch, key) {
      keys.set(epoch, key);
      lastActivity = now();
    },
    has(epoch) { return keys.has(epoch); },
    // A retained key decrypts; a wiped one must cause a hard failure.
    async decrypt(epoch) {
      if (epoch > currentEpoch) throw new Error(`Epoch ${epoch} is in the future.`);
      if (!keys.has(epoch)) throw new Error(`Epoch ${epoch} key destroyed or unknown.`);
      return keys.get(epoch);
    },
    advanceEpoch(newEpoch, newKey) {
      currentEpoch = newEpoch;
      if (newKey !== undefined) keys.set(newEpoch, newKey);
      // Destroy every key older than the window, including genesis gaps.
      const cutoff = newEpoch - retention;
      for (const epoch of [...keys.keys()]) {
        if (epoch <= cutoff) keys.delete(epoch);
      }
      lastActivity = now();
      return { currentEpoch, destroyed: [...keys.keys()] };
    },
    // Gap check for rejoin: a device whose snapshot is older than the
    // retention window cannot chain-replay; it needs a fresh Welcome.
    canChainReplay(deviceEpoch) {
      return deviceEpoch > currentEpoch - retention;
    },
    lastActivity: () => lastActivity,
    _keyCount: () => keys.size,
  };
}

// Bind transcript hashes to epochs so an old snapshot claims a verifiable
// position in the chain.
export async function bindEpochTranscript({ groupId, epoch, transcriptHash }) {
  return canonicalHash({ epoch, groupId: String(groupId || ''), t: 'mlsretention', transcriptHash });
}

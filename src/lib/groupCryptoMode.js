// The MLS opt-in for groups. The MLS v1 lane (src/lib/mlsTest/, the OpenMLS
// prototype behind PROTOCOL_TEST_MLS_ENABLED) is proven in the test profile
// and pending its governance review; this flag is the promotion switch.
// Group traffic stays on the shipped kind-9 groupCipher path until the person
// turns this on, and the flag defaults OFF.
//
// Account-wide by design, mirroring dmRatchetMode: a per-group split would
// make the receive side guess which crypto a sender chose. The honest scope
// of this stage is recorded in docs/CRYPTO-CUTOVER.md Part 2: the flag and
// its governance-readiness audit ship now; routing live group traffic through
// the MLS engine is the follow-up that depends on that audit's outcome.
import { scopedGet, scopedSet } from './storage.js';

export const GROUP_MLS_KEY = 'group_mls_mode';

export function groupMlsEnabled() {
  return scopedGet(GROUP_MLS_KEY, false) === true;
}

export function setGroupMls(enabled) {
  scopedSet(GROUP_MLS_KEY, enabled === true);
  return groupMlsEnabled();
}

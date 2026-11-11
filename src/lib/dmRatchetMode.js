// The DM ratchet opt-in. The wasm double ratchet and its lane plumbing are
// proven inside the test-profile DM lane; this flag is the promotion switch
// that lets an account send and receive ratcheted plain-text DMs through the
// same primitives. It persists in the account's scoped storage, so it
// survives reload and account switch, and it defaults OFF: the shipped NIP-44
// path stays the wire until the person turns this on.
//
// Account-wide by design: the lane's route keys are derived per account pair,
// and a per-conversation split would make the receive side guess which flag
// the sender meant. The one-sided cost is documented in the cutover notes:
// a peer on an older build cannot open ratcheted messages until they update
// and opt in.
import { scopedGet, scopedSet } from './storage.js';

export const DM_RATCHET_KEY = 'dm_ratchet_mode';

export function dmRatchetEnabled() {
  return scopedGet(DM_RATCHET_KEY, false) === true;
}

export function setDmRatchet(enabled) {
  scopedSet(DM_RATCHET_KEY, enabled === true);
  return dmRatchetEnabled();
}

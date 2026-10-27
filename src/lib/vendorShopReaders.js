// Reader helpers for the public faces of a vendor shop: reviews (10005),
// dispute riders (10006) and txid bulletins (10007).
//
// Law this device keeps while reading, verbatim:
//   This device never calls a public block explorer. The reader checks a
//   txid on their own terms; these helpers hand over events, never verdicts.
//   No amount is ever read from a bulletin on any rail — a txid proves a
//   payment happened, never how much.
//
// The derivation of what an event MEANS lives in its own module and its
// own test: reviews/disputes semantics in reputation.js and disputes.js,
// the proven count in vendorStats.js. Nothing here re-derives or filters
// beyond kind and binding — a reader's job is to fetch and hand over.

import { queryWithTimeout } from './relays.js';
import { BULLETIN_KIND } from './vendorStats.js';
import { DISPUTE_KIND } from './disputes.js';

export const REVIEW_KIND = 10005;

// All of a shop's public review-thread events for one vendor pubkey, one
// kind at a time. Binding filter: kind 10005/10006 are published under
// '#p' = the vendor; bulletins are the vendor's own replaceable event, so
// they are fetched by author.
export async function fetchVendorThread(pool, relays, vendorPubkey, { timeoutMs = 4000 } = {}) {
  const vendor = String(vendorPubkey || '').toLowerCase();
  if (!vendor || !pool || !Array.isArray(relays) || !relays.length) return { reviews: [], disputes: [], bulletins: [] };
  const [reviews, disputes, bulletins] = await Promise.all([
    queryWithTimeout(pool, relays, { kinds: [REVIEW_KIND], '#p': [vendor] }, timeoutMs),
    queryWithTimeout(pool, relays, { kinds: [DISPUTE_KIND], '#p': [vendor] }, timeoutMs),
    queryWithTimeout(pool, relays, { kinds: [BULLETIN_KIND], authors: [vendor] }, timeoutMs),
  ]);
  return { reviews, disputes, bulletins };
}

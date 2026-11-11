// The account key is still the DM routing identifier for compatibility.
// Keep filter construction in one place so privacy tests exercise the exact
// filters sent by the application and future address migration has one seam.
import { GIFT_WRAP_KIND } from './giftWrap.js';

export function dmSubscriptionFilters(accountPubkey, since, extraRoutePubkeys = []) {
  if (typeof accountPubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(accountPubkey)) return [];
  // Test-profile DM lane routes (TEST-ONLY lane behind the per-account
  // opt-in): wraps addressed to a derived route pubkey carry that key as
  // their single p tag, so the inbox must also watch it or integrated lane
  // sends never reach onevent. Only hex64 keys pass validation; malformed
  // entries are dropped silently rather than producing a broken filter.
  const routeKeys = (Array.isArray(extraRoutePubkeys) ? extraRoutePubkeys : [])
    .filter((key) => typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key) && key.toLowerCase() !== accountPubkey.toLowerCase());
  const pKeys = [accountPubkey, ...routeKeys];
  return [
    { kinds: [4, GIFT_WRAP_KIND], '#p': pKeys, since },
    { kinds: [4], authors: [accountPubkey], since },
  ];
}

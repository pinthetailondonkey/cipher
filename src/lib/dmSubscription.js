// The account key is still the DM routing identifier for compatibility.
// Keep filter construction in one place so privacy tests exercise the exact
// filters sent by the application and future address migration has one seam.
import { GIFT_WRAP_KIND } from './giftWrap.js';

export function dmSubscriptionFilters(accountPubkey, since) {
  if (typeof accountPubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(accountPubkey)) return [];
  return [
    { kinds: [4, GIFT_WRAP_KIND], '#p': [accountPubkey], since },
    { kinds: [4], authors: [accountPubkey], since },
  ];
}

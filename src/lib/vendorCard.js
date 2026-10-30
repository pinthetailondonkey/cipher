import { urlsFor } from './egress';

// The public card a vendor's menu carries on the group relay.
//
// A stranger who opens a menu from Discover has the group relay and nothing
// else. The app already resolves missing names from it (the bootstrap profile
// read covers general and group relays together), so a vendor's name and
// picture have to be there, and an ordinary account's must not.
//
// That boundary is this file's whole job, and it is held in three places:
// the publish refuses anything that is not vendor mode, the content is
// rebuilt from four named fields so a wider object cannot leak through, and a
// caller that hands over an event already signed gets it refused if its
// content carries a fifth key.
//
// The relay says it may delete its data. A card fetched there is
// discoverable, not durable, and is never evidence of anything.

export const VENDOR_CARD_FIELDS = ['name', 'display_name', 'about', 'picture'];

const text = (value) => (typeof value === 'string' ? value : '');

// Exactly these four fields, and no others. A receipt, an address, a balance
// or a review cannot widen it: the object is built here, not spread.
export function vendorCardContent(profile = {}) {
  return {
    name: text(profile.name),
    display_name: text(profile.display_name || profile.displayName),
    about: text(profile.about),
    picture: text(profile.picture),
  };
}

// The one relay set this card may reach. It is the group relay and nothing
// else, and the set lives in the egress inventory rather than here.
export function vendorCardRelays() {
  return urlsFor('vendorCard');
}

export async function buildVendorCardEvent(profile, sk, now = Date.now()) {
  if (!sk) return null;
  const { finalizeEvent } = await import('nostr-tools');
  return finalizeEvent({
    kind: 0,
    created_at: Math.floor(now / 1000),
    tags: [],
    content: JSON.stringify(vendorCardContent(profile)),
  }, sk);
}

function carriesOnlyTheCard(event) {
  try {
    const content = JSON.parse(event?.content || '{}');
    if (!content || typeof content !== 'object' || Array.isArray(content)) return false;
    return Object.keys(content).every((key) => VENDOR_CARD_FIELDS.includes(key));
  } catch {
    return false;
  }
}

// Publishes the vendor's card to the group relay. Every refusal is a plain
// skip, never a throw: a buyer saving a profile is not an error path.
export async function publishVendorCard({
  isVendor,
  identity,
  profile,
  event,
  relays,
  pool: injected,
  now = Date.now(),
} = {}) {
  const targets = Array.isArray(relays) ? relays : vendorCardRelays();
  const refused = (skipped) => ({ published: false, skipped, relays: [...targets] });

  if (isVendor !== true) return refused('not-a-vendor');
  if (!targets.length) return refused('group-relay-off');

  const signed = event || await buildVendorCardEvent(profile || {}, identity?.sk, now);
  if (!signed) return refused('no-account');
  if (!carriesOnlyTheCard(signed)) return refused('card-carries-extra');

  let pool = injected;
  try {
    if (!pool) {
      const { SimplePool } = await import('nostr-tools');
      pool = new SimplePool();
    }
    const results = await Promise.allSettled(pool.publish(targets, signed));
    return {
      published: results.some((result) => result.status === 'fulfilled'),
      skipped: null,
      relays: [...targets],
      id: signed.id,
    };
  } catch {
    return refused('publish-failed');
  } finally {
    if (pool && !injected) {
      try { pool.close(targets); } catch { /* nothing left to close */ }
    }
  }
}

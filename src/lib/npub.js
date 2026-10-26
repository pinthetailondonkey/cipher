import { nip19 } from 'nostr-tools';

const HEX_KEY_RE = /^[0-9a-f]{64}$/i;

// Keys are shown as npub, never as raw hex. One helper for the whole app so
// no surface has to invent its own fallback again.
export function npubFromHex(pubkey) {
  const raw = String(pubkey || '').trim();
  if (HEX_KEY_RE.test(raw)) {
    try {
      return nip19.npubEncode(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

// A short npub for tight rows: npub1abcd… (8 visible, adjustable).
export function shortNpub(pubkey, chars = 10) {
  const npub = npubFromHex(pubkey);
  if (!npub) return '';
  if (npub.length <= chars + 4) return npub;
  return `${npub.slice(0, chars)}…`;
}

// One shared name fallback: whatever the profile says, else a short npub.
// A hex key never renders as a person's name.
export function noHexName(profile, pubkey) {
  const name = profile?.displayName || profile?.name || profile?.display_name || profile?.picture_alt;
  if (name) return name;
  return shortNpub(pubkey) || 'No name yet';
}

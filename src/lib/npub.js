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

// A scanned QR code lands here. The shapes a Cipher key travels in: a bare
// npub, a nostr:npub: link, or the raw 64-char hex. Anything else is
// someone else's QR — copy stays the only action. Returns '' when the
// value names no key.
export function pubkeyFromScanned(value) {
  const raw = String(value || '').trim();
  if (HEX_KEY_RE.test(raw)) return raw.toLowerCase();
  const unwrapped = raw.startsWith('nostr:') ? raw.slice(6) : raw; // protocol prefix, not UI copy
  if (!/^npub1/i.test(unwrapped)) return '';
  try {
    const decoded = nip19.decode(unwrapped);
    if (decoded?.type === 'npub' && HEX_KEY_RE.test(String(decoded.data))) {
      return String(decoded.data).toLowerCase();
    }
  } catch {
    // a broken bech32 string is still copyable text, not a key
  }
  return '';
}

// One shared name fallback: whatever the profile says, else a short npub.
// A hex key never renders as a person's name.
export function noHexName(profile, pubkey) {
  const name = profile?.displayName || profile?.name || profile?.display_name || profile?.picture_alt;
  if (name) return name;
  return shortNpub(pubkey) || 'No name yet';
}

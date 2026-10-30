import { nip19 } from 'nostr-tools';

// What a scanned code can be, before anything acts on it. A QR used to
// dead-end in Copy unless it happened to hold a key; every shape Cipher
// itself hands out is recognised here instead. This is a classifier, not a
// router: it names the door, the screen opens it, and a group still enters
// by the one boot path every other link uses.

const HEX64 = /^[0-9a-f]{64}$/i;
const NOTE_PATH = /^\/note\/?$/;

function clean(value) {
  return String(value ?? '').trim().replace(/^nostr:/i, '');
}

// A group id travels as the 64-hex id in a path or a ?g= style parameter.
function groupFromUrl(url) {
  const pathMatch = url.pathname.match(/^\/([0-9a-f]{64})\/?$/i);
  if (pathMatch) return pathMatch[1].toLowerCase();
  for (const key of ['g', 'group', 'join']) {
    const found = url.searchParams.get(key);
    if (found && found.trim()) return found.trim();
  }
  const naddrParam = url.searchParams.get('naddr');
  if (naddrParam) {
    const decoded = decodeNaddr(naddrParam.trim());
    if (decoded) return decoded;
  }
  return '';
}

function decodeNaddr(value) {
  try {
    const decoded = nip19.decode(value);
    if (decoded?.type !== 'naddr') return '';
    const kind = Number(decoded.data?.kind);
    if (kind !== 39000 && kind !== 39001) return '';
    return String(decoded.data?.identifier ?? '').trim();
  } catch {
    return '';
  }
}

// Every door this code can open, best first. A bare 64-hex is genuinely
// ambiguous — a group id and a public key have the same shape — so both
// doors are offered rather than one being guessed.
export function scannedTargets(rawValue) {
  const value = clean(rawValue);
  if (!value) return [];

  let url = null;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }

  if (url) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
    const noteFragment = NOTE_PATH.test(url.pathname) ? url.hash.replace(/^#/, '') : '';
    if (noteFragment) return [{ kind: 'note', fragment: noteFragment }];
    const product = url.searchParams.get('product');
    const vendor = url.searchParams.get('vendor');
    if (product && vendor) return [{ kind: 'product', id: product.trim(), vendor: vendor.trim() }];
    const chat = url.searchParams.get('chat');
    if (chat && chat.trim()) return [{ kind: 'chat', value: chat.trim() }];
    const group = groupFromUrl(url);
    if (group) return [{ kind: 'group', id: group }];
    return [];
  }

  const naddrGroup = decodeNaddr(value);
  if (naddrGroup) return [{ kind: 'group', id: naddrGroup }];

  if (/^naddr1/i.test(value)) return [];
  if (/^npub1|^nprofile1/i.test(value)) return [{ kind: 'profile', value }];
  if (HEX64.test(value)) {
    return [{ kind: 'group', id: value.toLowerCase() }, { kind: 'profile', value: value.toLowerCase() }];
  }
  return [];
}

// Where a door leads. The app's boot path reads exactly these shapes, so a
// scanned group joins the way every link joins — no second join path.
export function scannedHref(target, origin = '') {
  const base = String(origin || '').replace(/\/$/, '');
  if (!target) return '';
  if (target.kind === 'group') return `${base}/?g=${encodeURIComponent(target.id)}`;
  if (target.kind === 'product') return `${base}/?product=${encodeURIComponent(target.id)}&vendor=${encodeURIComponent(target.vendor)}`;
  if (target.kind === 'chat') return `${base}/?chat=${encodeURIComponent(target.value)}`;
  if (target.kind === 'note') return `${base}/note#${target.fragment}`;
  return '';
}

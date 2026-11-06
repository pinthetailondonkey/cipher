// One door for a URL that came off the wire.
//
// A picture can name any host at all: the URL rides inside a message body, a
// profile, or a listing, so it is never in egress.js and the wall cannot see
// it. That makes the render path the only place a stray address can become a
// request, and this module is that place's gate. Two rules:
//
//   1. ORIGIN. External URLs must match an exact media origin the user has
//      configured in Connections. Same-origin and local data/blob URLs stay
//      available. A scheme or host supplied by a sender is never approval.
//   2. WHAT RIDES ALONG. Every read is one GET with no Referer, no credentials,
//      and redirects refused. An approved host still sees the reader's IP,
//      requested path, and access time.
//
import { blossomServers } from './egress.js';

export const MEDIA_REFERRER_POLICY = 'no-referrer';

// Spread into a fetch a reader makes for wire-supplied bytes. credentials
// must be omitted, not merely same-origin: a media host can set a cookie on
// a picture it served, and omitting means the next picture from that host is
// not already labelled with it.
export const MEDIA_FETCH_OPTIONS = Object.freeze({
  referrerPolicy: MEDIA_REFERRER_POLICY,
  credentials: 'omit',
  redirect: 'error',
});

// Schemes with no host to dial. Allowed through for a local render.
const LOCAL_SCHEMES = new Set(['data:', 'blob:']);

// The address to render or dial, or '' when the wire-supplied value is nothing
// this side can use. `base` stands in for the document origin in tests.
export function mediaHref(value, base = globalThis.location?.origin, approvedServers = blossomServers()) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    if (!base) return '';
    try {
      url = new URL(text, base);
    } catch {
      return '';
    }
  }
  if (LOCAL_SCHEMES.has(url.protocol)) return url.href;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  let sameOrigin = false;
  try { sameOrigin = Boolean(base) && new URL(base).origin === url.origin; } catch { /* no current origin */ }
  const approvedOrigins = new Set((Array.isArray(approvedServers) ? approvedServers : [])
    .flatMap((server) => {
      try {
        const origin = new URL(String(server)).origin;
        return ['http:', 'https:'].includes(new URL(origin).protocol) ? [origin] : [];
      } catch {
        return [];
      }
    }));
  if (!sameOrigin && !approvedOrigins.has(url.origin)) return '';
  return url.href;
}

// The host to show a reader, '' when the address never leaves the device.
export function mediaHostOf(value, approvedServers = blossomServers()) {
  const href = mediaHref(value, globalThis.location?.origin, approvedServers);
  if (!href) return '';
  try {
    const url = new URL(href);
    return LOCAL_SCHEMES.has(url.protocol) ? '' : url.host;
  } catch {
    return '';
  }
}

// One GET for wire-supplied bytes: the guarded address, nothing else along.
// Throws for a stray address, so no request is made at all.
export function mediaFetch(value, fetchImpl = globalThis.fetch, { approvedServers, signal } = {}) {
  const href = mediaHref(value, globalThis.location?.origin, approvedServers);
  if (!href) throw new Error('The attachment names no host to dial.');
  return fetchImpl(href, { ...MEDIA_FETCH_OPTIONS, ...(signal ? { signal } : {}) });
}

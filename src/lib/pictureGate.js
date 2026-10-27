// The picture gate, shared by every place an <img> renders (Picture.jsx).
// Under the no-IP-leak law (docs/NO-IP-LEAKS.md) a plain-browser build must
// not fetch a picture from a clearnet host: the fetch itself tells that host
// the viewer's address, and the host was picked by the poster, not the
// viewer. Onion addresses stay open everywhere, and the desktop shell (which
// rides its bundled Tor — it rewrites the whole user agent to "Cipher/…")
// may fetch freely. Everything else is refused with a plain-words label; a
// deliberate tap still opens the original, which is the disclosed choice.
function ridesTor() {
  if (typeof navigator === 'undefined') return false;
  return /^Cipher\//.test(navigator.userAgent);
}

export function pictureHost(src, base = '') {
  const raw = String(src || '').trim();
  try {
    const fallbackBase = typeof window === 'undefined' ? undefined : window.location.href;
    const host = new URL(raw, base || fallbackBase).hostname;
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(host)) return '';
    return host;
  } catch {
    return '';
  }
}

export function pictureIsGated(src) {
  const host = pictureHost(src);
  if (!host || host.endsWith('.onion')) return false;
  return !ridesTor();
}

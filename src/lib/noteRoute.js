// Which screen /note renders. A note link carries everything it needs in the
// fragment, so the decision is made from the address alone — before any
// session, vault or account is consulted. That is the whole point of the page:
// the person holding the link may have no account at all, and the link is not
// a door into the app.
//
// Kept away from App.jsx so the rule can be driven by a test without booting
// the app: a stray boolean in here is what would show a stranger the lock
// screen, and a test that renders App can see it.
// A tab remembers WHICH note it is showing — never the key that opens it.
// The reader clears the fragment from the address bar the moment the text is on
// screen, because the fragment IS the secret, and the route went with it: the
// next render found no note, the identity gate took the screen and the reader
// was unmounted in the middle of a life it had already spent.
//
// What the tab keeps is the note's identifier, which is not a secret and is
// already in the URL: the relay's `d` hash (sha256 of the key, never the key)
// or the carrier's 16-byte id, which the host holds too. A reload therefore
// needs no key and no request — the reader finds the id in the device's own burn
// ledger and says the honest gone line. Keeping the fragment instead would have
// put the key where this product's model says it never goes: readable by any
// script on the origin, written to disk by a browser's session restore, and on
// the relay path a copy of it opens a note whose one-open is only a local rule.
//
// Per tab, never per account and never shared: a new tab, another device or a
// forwarded link has none of this. It is read ONLY on the note path, so a tab
// that once read a note is not captured when the app is opened at /.
const TAB_NOTE_KEY = 'cipher_note_route_id';

// Which transport carried the note. A tag the page compares, never a word a
// person reads. not UI copy
const asTransport = (value) => (value === 'carrier' ? 'carrier' : 'relay');

export function rememberNoteRoute({ id, transport } = {}) {
  if (!id) return;
  const record = { id: String(id), transport: asTransport(transport) };
  try { globalThis.sessionStorage?.setItem(TAB_NOTE_KEY, JSON.stringify(record)); } catch { /* nothing to keep */ }
}

function tabNoteRoute() {
  try {
    const raw = globalThis.sessionStorage?.getItem(TAB_NOTE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.id !== 'string' || !parsed.id) return null;
    return { id: parsed.id, transport: asTransport(parsed.transport) };
  } catch {
    return null;
  }
}

// A live link answers with its fragment; a note this tab already showed answers
// with its { id, transport } after the reader cleared the address; anything else
// is not the note route at all.
export function noteFragmentFor({ pathname, hash } = {}) {
  const path = String(pathname || '').replace(/\/+$/, '');
  if (path !== '/note') return null;
  const fragment = String(hash || '').replace(/^#/, '').trim();
  return fragment || tabNoteRoute();
}

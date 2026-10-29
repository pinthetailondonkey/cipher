// Which screen /note renders. A note link carries everything it needs in the
// fragment, so the decision is made from the address alone — before any
// session, vault or account is consulted. That is the whole point of the page:
// the person holding the link may have no account at all, and the link is not
// a door into the app.
//
// Kept away from App.jsx so the rule can be driven by a test without booting
// the app: a stray boolean in here is what would show a stranger the lock
// screen, and a test that renders App can see it.
// A tab remembers the note it is showing. The reader clears the fragment from
// the address bar as soon as the text is on screen — the link is a secret and
// must not linger there — and the route went with it: the next render found no
// note, the identity gate took the screen and the reader was unmounted in the
// middle of a life it had already spent. An address cannot carry the route once
// the reader has edited that address, so the tab keeps it instead. That is also
// what makes a reload of the same tab honest: it lands on the reader's gone
// state rather than on "Welcome to Cipher".
//
// Per tab, never per account and never shared: a new tab, someone else's device
// or a forwarded link has none of this. It is read ONLY on the note path, so a
// tab that once read a note is not captured when the app is opened at /.
const TAB_FRAGMENT_KEY = 'cipher_note_route_fragment';

function tabFragment() {
  try {
    const held = globalThis.sessionStorage?.getItem(TAB_FRAGMENT_KEY);
    return held ? String(held) : null;
  } catch {
    return null;
  }
}

export function rememberNoteRoute(fragment) {
  try { globalThis.sessionStorage?.setItem(TAB_FRAGMENT_KEY, String(fragment)); } catch { /* nothing to keep */ }
}

export function noteFragmentFor({ pathname, hash } = {}) {
  const path = String(pathname || '').replace(/\/+$/, '');
  if (path !== '/note') return null;
  const fragment = String(hash || '').replace(/^#/, '').trim();
  return fragment || tabFragment();
}

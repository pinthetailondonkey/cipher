// Which screen /note renders. A note link carries everything it needs in the
// fragment, so the decision is made from the address alone — before any
// session, vault or account is consulted. That is the whole point of the page:
// the person holding the link may have no account at all, and the link is not
// a door into the app.
//
// Kept away from App.jsx so the rule can be driven by a test without booting
// the app: a stray boolean in here is what would show a stranger the lock
// screen, and a test that renders App can see it.
export function noteFragmentFor({ pathname, hash } = {}) {
  const path = String(pathname || '').replace(/\/+$/, '');
  if (path !== '/note') return null;
  const fragment = String(hash || '').replace(/^#/, '').trim();
  return fragment || null;
}

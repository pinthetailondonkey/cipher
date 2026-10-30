// The public reader's one network call. The page that opens a note link has no
// account, so this file never asks for one: the carrier link is a plain fetch
// to the note host, and a relay link is exactly one query for the note's `#d`
// (sha256 of the key — never the key), under a deadline so a silent relay
// cannot leave the page spinning forever.
//
// The open is taken with `hold`, so the burn lands only after the page has the
// text in hand. A read that is destroyed on the way to the screen would spend
// the note without ever showing it.
import { generalRelays } from './relays.js';
import { isCarrierFragment, openDeadDropNote } from './deadDrop.js';

// Long enough for a slow relay, short enough that a person does not wonder
// whether the page is broken. Reused as a plain line on screen ("The note
// could not be opened."), which is the reader's existing fallback wording.
//
// It guards the RELAY path only. A relay query can be given up on: the note
// stays on the relay, and this device's one-open is its own ledger mark, so a
// silent relay costs a wait and nothing else. A carrier note is different — the
// host deletes it as it hands it over, so the moment that fetch starts the note
// is already spent, and the copy on its way back is the only one left. A
// deadline on that fetch does not cancel it; it abandons it, and then the page
// says "could not be opened" about a note nobody anywhere can read. So the
// carrier branch below waits for its answer however long it takes.
const DEADLINE_MS = 8000;

export async function openNoteLink({
  fragment,
  relays = generalRelays,
  timeoutMs = DEADLINE_MS,
} = {}) {
  const carrier = isCarrierFragment(fragment);
  // Only a relay note needs a pool. A carrier note is one fetch, and building
  // a pool for it would open sockets the page does not use.
  let pool = null;
  if (!carrier) {
    const { SimplePool } = await import('nostr-tools');
    pool = new SimplePool({ enablePing: false });
  }

  let timer = null;
  try {
    const opening = openDeadDropNote({ fragment, pool, relays, hold: true });
    // A carrier answer is the last copy of its note, so this branch waits for
    // the host rather than racing it. Everything after this line is shared: the
    // same result, the same failures, and the same burn handed back to the page.
    const opened = carrier ? await opening : await Promise.race([
      opening,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('The note could not be opened.')), timeoutMs);
      }),
    ]);
    // `hash` is the note's identifier, not its key: the relay's `d` hash
    // (sha256 of the key) or the carrier's id. It is what the tab may keep so a
    // reload can say the honest gone line without a key and without a request.
    // `transport` tags which carried it. Both are values the screen compares,
    // never words a person reads. not UI copy
    return {
      text: opened.text,
      hash: opened.hash,
      burn: opened.burn,
      transport: carrier ? 'carrier' : 'relay', // not UI copy
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (pool) {
      // One query, then the sockets go. A note page that leaves a relay
      // connection open has told the relay more than it needed to.
      try { pool.destroy?.(); } catch { /* already gone */ }
    }
  }
}

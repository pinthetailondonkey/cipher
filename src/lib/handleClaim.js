// Is a handle free?
//
// The claim is a kind-10003 published alongside the profile with a
// cipher_username_<handle> tag (useIdentity.js). Reading it is best-effort
// because publishing one is: any key can forge a claim on an open relay, so
// this can make a squatting visible, never impossible.
//
// Three answers, and they are three, not two:
//   available — asked, answered, no claim on that tag.
//   taken     — asked, answered, a claim exists. Refuse, and say so plainly.
//   unknown   — did not answer: timed out or threw. Retried once first.
//
// What unknown does is a decision, not a default. It ALLOWS the signup. The
// reason: a check that did not answer must not be read as an answer, and the
// two wrong ways to do that are both worse than allowing. Reading unknown as
// taken tells a person on a slow relay that their handle is taken when it was
// never looked up — that wrong answer is what got the check bypassed in the
// first place. Reading unknown as available by accident, which the old code
// did whenever a relay refused the read, is the same lie wearing the other
// face. Allowing is also never a regression: the check was bypassed outright
// before this, so every path allowed; now two of the three states refuse.
//
// The trade this names: squatting protection stays best-effort and
// client-side. A real person on one bar is never blocked, and an unchecked
// signup is SILENT to them — nothing on the screen says the name was not
// checked. Anything louder would have to be its own screen, and a warning
// nobody can act on is noise.

export const HANDLE_AVAILABLE = 'available';
export const HANDLE_TAKEN = 'taken';
export const HANDLE_UNKNOWN = 'unknown';

// Long enough for two public relays to answer, short enough that the signup
// button is not a spinner a person gives up on. One retry, so the worst case
// is two of these.
export const HANDLE_LOOKUP_MS = 3000;

const TIMED_OUT = Symbol('handle-lookup-timeout');

export function handleFilter(username) {
  return { kinds: [10003], '#t': [`cipher_username_${username}`], limit: 5 };
}

// An answer that is not a list is not an empty list: a refused or garbled read
// must not come out looking like "nobody holds this name".
export function classifyClaimEvents(events) {
  if (!Array.isArray(events)) return HANDLE_UNKNOWN;
  return events.length > 0 ? HANDLE_TAKEN : HANDLE_AVAILABLE;
}

async function askOnce(read, filter, timeoutMs) {
  let timer;
  try {
    const answer = await Promise.race([
      // Wrapped so a read that throws synchronously is still a rejection here.
      Promise.resolve().then(() => read(filter, timeoutMs)),
      // The deadline is what settles a read that never answers, so it must
      // NOT be unref'd: an unreferenced timer lets the event loop empty and
      // the race never resolves at all.
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (answer === TIMED_OUT) return HANDLE_UNKNOWN;
    if (answer === undefined) return HANDLE_UNKNOWN;
    return classifyClaimEvents(answer);
  } catch {
    return HANDLE_UNKNOWN;
  } finally {
    clearTimeout(timer);
  }
}

// `read(filter, timeoutMs)` is supplied by the caller and returns the events
// for that filter. Keeping the network out of this file is what makes the slow
// case and the refused case testable without a relay.
export async function lookupHandleClaim({ read, username, timeoutMs = HANDLE_LOOKUP_MS, retries = 1 } = {}) {
  if (typeof read !== 'function' || !username) return HANDLE_UNKNOWN;
  const filter = handleFilter(username);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const verdict = await askOnce(read, filter, timeoutMs);
    if (verdict !== HANDLE_UNKNOWN) return verdict;
  }
  return HANDLE_UNKNOWN;
}

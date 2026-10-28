// What a send actually did, in one place.
//
// The composer used to decide this three times by hand, and the callers fired
// their "sent" toast on the return value alone, so a send the relays refused
// reported success one line after reporting the failure. One function answers
// for every path: 'sent', 'securing' (a group message waiting on a key) or
// 'failed'. Only 'sent' earns a success toast.
export function sendOutcome(result) {
  if (result?.success !== true) {
    // A group message with no key yet is not a failure: the bubble says so
    // and the send goes out once the key arrives.
    return result?.error === 'NO_KEY' ? 'securing' : 'failed';
  }
  // Success with no event id is not a message anyone can read back.
  return result.event?.id ? 'sent' : 'failed';
}

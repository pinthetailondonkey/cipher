// One run at a time.
//
// Buy has no disabled state, and a tap that looks ignored gets tapped again.
// The guard is the smallest thing that makes the second press harmless: while
// a run is in flight every further call returns undefined untouched, and the
// flag clears in a finally, so a run that throws or is rejected does not lock
// the button out.
export function createSingleFlight() {
  let inFlight = false;
  return async function run(task) {
    if (inFlight) return undefined;
    inFlight = true;
    try {
      return await task();
    } finally {
      inFlight = false;
    }
  };
}

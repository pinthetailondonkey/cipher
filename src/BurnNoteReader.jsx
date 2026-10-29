import { useEffect, useRef, useState } from 'react';
import { openNoteLink } from './lib/noteReader';
import { deadDropConsumed, isCarrierFragment } from './lib/deadDrop.js';
import { rememberNoteRoute } from './lib/noteRoute';

// The page a note link opens on. It is mounted before the app's identity gate
// and takes nothing from the store: no account, no vault, no chat. The link
// carries the whole secret in its fragment, so the page needs nothing else.
//
// Two transports, two promises, and the words say which one is true here:
//   carrier — the note host hands it over once and deletes it on that fetch;
//   relay   — the one-open is this device's own rule and nothing else. The
//             relay copy is still there for anyone else who holds the link, so
//             this page says what happens ON THIS DEVICE and never claims the
//             server deleted anything.
// One limit of the carrier path, recorded here rather than fixed: the deadline
// in noteReader.js is a timer, not a cancel. A host slow enough to cross it can
// still delete the note on the fetch that is already in flight, so the page can
// say "The note could not be opened." about a note that no longer exists
// anywhere — the one shape where "gone from the server" is true and nobody
// received the text.
//
// The failure lines are the reader's own, imported by message from deadDrop.js
// — "This note was already opened on this device.", "The note is gone or was
// never here.", "This note could not be opened — the link was altered." — so
// the page and the app's modal say one thing in one vocabulary. This is the
// only line this file owns, and it is the app's existing fallback.
const COULD_NOT_OPEN = 'The note could not be opened.';
const ALREADY_OPEN = 'This note was already opened on this device.';
const GONE = 'The note is gone or was never here.';

// A reload of a tab that already showed this note. No key is kept, so nothing
// can be opened and no request is made: the tab's own burn ledger answers, and
// the page says the line the reader already uses for it. If the ledger has no
// record of it — a storage write that failed — the honest line is that the note
// is gone, not that someone read it.
function goneState({ id }) {
  return { status: 'gone', message: deadDropConsumed(id) ? ALREADY_OPEN : GONE };
}

// `fragment` is a live link. `note` is the tab's { id, transport } record, which
// arrives only after this tab has already shown the note and cleared the
// address, so it shows the gone state and touches nothing on the network.
export default function BurnNoteReader({ fragment = null, note = null }) {
  const [state, setState] = useState(() => (note ? goneState(note) : { status: 'opening' }));
  const burned = useRef(null);
  const textRef = useRef(null);
  const carrier = note ? note.transport === 'carrier' : isCarrierFragment(fragment);

  useEffect(() => {
    if (note) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const opened = await openNoteLink({ fragment });
        if (cancelled) return;
        burned.current = opened.burn || null;
        setState({ status: 'open', text: opened.text, id: opened.hash, transport: opened.transport });
      } catch (error) {
        if (!cancelled) setState({ status: 'failed', message: error?.message || COULD_NOT_OPEN });
      }
    })();
    return () => { cancelled = true; };
  }, [fragment, note]);

  // The address bar keeps the link until the text is actually on the screen.
  // A failed open put nothing on screen, so clearing the fragment there would
  // throw the link away without showing anyone the note.
  useEffect(() => {
    if (state.status !== 'open') return;
    // The tab keeps WHICH note this was — its id, never the key — before the
    // address loses it: this page stays the page on the next render, and a
    // reload of the same tab lands on the gone state rather than on the app's
    // front door.
    rememberNoteRoute({ id: state.id, transport: state.transport });
    try { window.history.replaceState(null, '', window.location.pathname); } catch { /* nothing to clean */ }
    // The note is spent only now: the text is in hand and on the screen.
    try { burned.current?.(); } catch { /* the ledger mark is best-effort */ }
  }, [state]);

  const copyText = async () => {
    const text = state.text || '';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The clipboard can be refused outright. Selecting the text is the
      // fallback that still lets the reader copy it by hand, and it says
      // nothing new on the screen.
      const node = textRef.current;
      if (node && window.getSelection && document.createRange) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges?.();
        selection?.addRange?.(range);
      }
    }
  };

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-[560px] flex-col justify-center px-6 py-10">
      <h1 className="text-2xl font-bold tracking-tight text-ink">A note that reads once</h1>
      {/* The lede invites a read, so it is not shown once there is nothing to
          read: a reloaded tab gets the heading and the honest gone line. */}
      {state.status !== 'gone' && (
        <p className="mt-1 text-[15px] text-inkMuted">
          {carrier
            ? 'Open it and it is gone from the server. There is no second read, not even for you.'
            : 'This note opens once on this device. Save the text — it will not open here again.'}
        </p>
      )}
      {state.status === 'gone' && (
        <p className="mt-5 text-[15px] text-inkMuted" role="status">
          {state.message}
        </p>
      )}
      {state.status === 'open' && (
        <>
          <pre
            ref={textRef}
            className="mt-5 whitespace-pre-wrap break-words rounded-xl border border-line bg-panelAlt p-4 text-[15px] text-ink"
          >
            {state.text}
          </pre>
          <button
            type="button"
            onClick={copyText}
            className="mt-5 min-h-[48px] rounded-xl border border-line bg-panelAlt px-4 py-3 text-[15px] font-semibold text-accentText"
          >
            Copy the text
          </button>
          {/* No "copied" line: the approved words are the heading, the two
              ledes, this button and the reader's own failure lines. A quiet
              confirmation would be new copy the founder has not seen. */}
        </>
      )}
      {state.status === 'opening' && <p className="mt-5 text-[15px] text-inkMuted">Opening…</p>}
      {state.status === 'failed' && (
        <p className="mt-5 text-[15px] text-inkMuted" role="status">
          {state.message}
        </p>
      )}
    </div>
  );
}

import React, { lazy, Suspense, useState } from 'react';
import { MotionConfig } from 'framer-motion';
import { useIdentity } from './useIdentity';
import { useChatStore } from './store/chatStore';
import { usePanicWipe } from './hooks/usePanicWipe';
import { noteFragmentFor } from './lib/noteRoute';
import LockScreen from './LockScreen';
// Charged statically, on purpose: the reader is the one screen a person with
// no account may reach, and a lazy chunk that fails to arrive would hand them
// the spinner instead of the note.
import BurnNoteReader from './BurnNoteReader';

const AuthenticatedApp = lazy(() => import('./AuthenticatedApp'));

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-scrim text-red-500 p-6 font-mono flex flex-col items-center justify-center">
          <h1 className="text-2xl font-bold mb-4">App Crashed</h1>
          <pre className="text-xs whitespace-pre-wrap bg-red-900/20 p-4 rounded-xl border border-red-500/50 w-full max-w-md overflow-auto">{this.state.error.toString()}</pre>
          <button onClick={() => window.location.reload()} className="mt-6 px-6 py-3 bg-ink text-scrim font-bold rounded-xl">Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function MainApp() {
  const identity = useIdentity();
  const panicWipeEnabled = useChatStore((state) => state.panicWipeEnabled);
  usePanicWipe(identity, panicWipeEnabled);

  // A note link is answered from the address alone, ahead of every identity
  // return below: the holder of the link may have no account, and asking for
  // one is the defect this page exists to end. Nothing here reads the store,
  // starts the chat bootstrap, or opens a relay until the reader asks for its
  // one query.
  // Latched once, on mount, and never recomputed. The reader clears the
  // fragment from the address bar on purpose the moment the text is shown, so
  // re-reading the address on every render would route a note link to the
  // identity gate one tick after the note appeared — the reader unmounted with
  // the note already spent. The route is owned from the first render until the
  // page is left.
  const [noteRoute] = useState(() => noteFragmentFor(window.location));
  if (typeof noteRoute === 'string') return <BurnNoteReader fragment={noteRoute} />;
  // The tab's record after the reader cleared the address: an identifier, no
  // key. The reader shows the gone state from its own ledger without a request.
  if (noteRoute) return <BurnNoteReader note={noteRoute} />;

  if (identity.loadingSession) {
    return <div className="h-[100dvh] bg-scrim flex items-center justify-center"><div className="w-8 h-8 border-4 border-ink/20 border-t-ink rounded-full animate-spin" /></div>;
  }

  if (!identity.sk) return <LockScreen identity={identity} />;

  return (
    <Suspense fallback={<div className="h-[100dvh] bg-scrim flex items-center justify-center"><div className="w-8 h-8 border-4 border-ink/20 border-t-ink rounded-full animate-spin" /></div>}>
      <AuthenticatedApp identity={identity} />
    </Suspense>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ErrorBoundary>
        <div className="relative min-h-[100dvh] bg-base">
          {/* One shell glow for the whole app, pre-baked as gradients instead
              of live blur (WebKit re-rasterizes a 120px blur every frame).
              Colors come from the one look (var(--glow-a/b)) in index.css;
              screens must not draw their own copies. */}
          <div className="pointer-events-none fixed inset-0" style={{
            background: 'radial-gradient(ellipse 55% 38% at 12% 0%, var(--glow-a), transparent 65%), radial-gradient(ellipse 50% 30% at 92% 100%, var(--glow-b), transparent 70%)',
          }} />
          <MainApp />
        </div>
      </ErrorBoundary>
    </MotionConfig>
  );
}

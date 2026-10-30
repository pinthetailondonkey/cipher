import React, { lazy, Suspense } from 'react';
import { MotionConfig } from 'framer-motion';
import { useIdentity } from './useIdentity';
import { useChatStore } from './store/chatStore';
import { usePanicWipe } from './hooks/usePanicWipe';
import LockScreen from './LockScreen';

const AuthenticatedApp = lazy(() => import('./AuthenticatedApp'));

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  // The screen somebody sees when this app breaks is not the place for a
  // module path. The founder's ruling: plain words on the screen, the detail
  // in the console, where the person debugging can find it and nobody else
  // has to read it.
  componentDidCatch(error, info) {
    console.error('Cipher stopped while drawing the screen:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-scrim text-red-500 p-6 flex flex-col items-center justify-center">
          <h1 className="text-2xl font-bold mb-4">Something went wrong</h1>
          <p className="text-sm text-center max-w-md">Cipher had to stop. Reload to carry on. The details are in the browser&rsquo;s console.</p>
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

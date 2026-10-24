import React, { lazy, Suspense } from 'react';
import { useIdentity } from './useIdentity';
import { useChatStore } from './store/chatStore';
import { usePanicWipe } from './hooks/usePanicWipe';
import LockScreen from './LockScreen';

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
        <div className="min-h-screen bg-black text-red-500 p-6 font-mono flex flex-col items-center justify-center">
          <h1 className="text-2xl font-bold mb-4">App Crashed</h1>
          <pre className="text-xs whitespace-pre-wrap bg-red-900/20 p-4 rounded-xl border border-red-500/50 w-full max-w-md overflow-auto">{this.state.error.toString()}</pre>
          <button onClick={() => window.location.reload()} className="mt-6 px-6 py-3 bg-white text-black font-bold rounded-xl">Reload</button>
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
    return <div className="h-screen bg-black flex items-center justify-center"><div className="w-8 h-8 border-4 border-white/20 border-t-white rounded-full animate-spin" /></div>;
  }

  if (!identity.sk) return <LockScreen identity={identity} />;

  return (
    <Suspense fallback={<div className="h-screen bg-black flex items-center justify-center"><div className="w-8 h-8 border-4 border-white/20 border-t-white rounded-full animate-spin" /></div>}>
      <AuthenticatedApp identity={identity} />
    </Suspense>
  );
}

export default function App() {
  return <ErrorBoundary><MainApp /></ErrorBoundary>;
}

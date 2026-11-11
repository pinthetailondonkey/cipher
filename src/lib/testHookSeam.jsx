// Test-only seam, imported only behind the VITE_TEST_HOOKS gate at its one
// call site (src/main.jsx). It renders nothing: a hidden host div runs the
// identity and DM hooks exactly as the real App does and publishes them on
// window under the names the probe pages already use, so a browser harness
// that drives the real rendered app can read them without reaching into
// React internals. A shipping build carries neither this import nor these
// globals.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { useIdentity } from '../useIdentity.js';
import { useNIP44DM } from '../hooks/useNIP44DM.js';

function HookSeam() {
  const identity = useIdentity();
  const dm = useNIP44DM({ identity });
  window.__identity = identity;
  window.__dm = dm;
  return null;
}

export function mountTestHookSeam() {
  if (document.getElementById('cipher-hook-seam')) return;
  const host = document.createElement('div');
  host.id = 'cipher-hook-seam';
  host.style.display = 'none';
  document.body.appendChild(host);
  ReactDOM.createRoot(host).render(React.createElement(HookSeam));
}

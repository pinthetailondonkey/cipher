import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .catch((error) => console.error('[offline] Service worker registration failed:', error));
  }, { once: true });
}

// Test seam, compiled in only for the UI-test build (VITE_TEST_HOOKS=1).
// The chat list reads the store's own `dms` map, not the database, so a
// screenshot of a real thread needs the store to hold one. A shipping build
// carries neither this import nor the global.
if (import.meta.env?.VITE_TEST_HOOKS === '1') {
  import('./store/chatStore').then(({ useChatStore }) => {
    window.__cipherStore = useChatStore;
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  
    <App />
  ,
)

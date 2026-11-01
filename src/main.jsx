import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Standalone (home-screen) apps run full-bleed under the status bar and the
// home indicator, and the indicator zone is WebKit's to reserve, so the tab
// bar must clear it. index.css floors the bottom safe area only for that
// mode (see the standalone rule there). iOS reports it through the
// `display-mode: standalone` media query (navigator.standalone is the older
// iOS-only flag); we tag <html> with the same attribute the stylesheet keys
// on so the rule also applies when measured in Chromium, which cannot emulate
// display-mode. Nothing in a normal browser tab sets the attribute, so the
// browser keeps the un-floored inset and renders byte-for-byte as before.
if (typeof window !== 'undefined') {
  const standalone = navigator.standalone === true
    || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  if (standalone) document.documentElement.setAttribute('data-standalone', '');
}

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

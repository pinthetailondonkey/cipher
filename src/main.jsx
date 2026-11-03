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
//
// Standalone also measures the strip described in index.css (WebKit 313800).
// The strip is the part of the physical screen below the viewport: no layout
// reaches it, so the only thing that can know its height is a measurement.
if (typeof window !== 'undefined') {
  const standalone = navigator.standalone === true
    || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  if (standalone) {
    document.documentElement.setAttribute('data-standalone', '');

    // --strip = physical screen height minus the tallest layout viewport seen.
    // Tracking the maximum, not the current innerHeight, is what keeps the
    // software keyboard out of the measurement: the keyboard shrinks
    // innerHeight (`interactive-widget=resizes-content`), which would
    // otherwise be read as an enormous strip. Rotation changes which axis
    // screen.height reports, so the maximum is re-seeded for it.
    //
    // The band is vertical, so only portrait is trusted with the measurement.
    // Landscape moves the indicator to the short edge and is a different
    // geometry; there the plain 34px floor is enough, and pinning 0 costs a
    // little precision but never safety. This matters because not every iOS
    // rotates screen.height — without the guard a landscape viewport would be
    // billed as the whole strip and the floor would vanish with it.
    //
    // Portrait is judged against `tallest`, not the current innerHeight, so the
    // software keyboard cannot look like a rotation: a 375x667 phone with the
    // keyboard up is 375x320, and comparing to that would call it landscape and
    // drop the band mid-sentence.
    //
    // The delta is also refused when it is not inset-sized. On a phone the only
    // thing between screen.height and innerHeight is the status bar, but a
    // resizable standalone surface (a desktop PWA window, an iPad in Split
    // View) is simply smaller than the display, and there the delta is a window
    // size, not a band. Above the window ceiling the strip is pinned to 0, so
    // those platforms keep the floor they had before this change. Nothing is
    // lost: a device that reports no band is a device this fix no-ops on.
    // Biggest real inset today is 62px (iPhone 16 Pro Max); 120 leaves room.
    const MAX_INSET = 120;
    let tallest = 0;
    const measureStrip = () => {
      const screenH = Math.round(window.screen?.height || 0);
      const innerH = Math.round(window.innerHeight || 0);
      if (!screenH || !innerH) return;
      if (innerH > tallest) tallest = innerH;
      const portrait = (window.innerWidth || 0) <= tallest;
      const delta = Math.max(0, screenH - tallest);
      const strip = portrait && delta > 0 && delta <= MAX_INSET ? delta : 0;
      document.documentElement.style.setProperty('--strip', `${strip}px`);
    };
    measureStrip();
    window.addEventListener('resize', measureStrip, { passive: true });
    window.addEventListener('orientationchange', () => {
      tallest = Math.round(window.innerHeight || 0);
      measureStrip();
    }, { passive: true });
  }
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

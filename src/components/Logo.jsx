import React, { useEffect, useState } from 'react';
import { currentTheme } from '../lib/theme';

// The mark recolors with the theme: blue is the Vault mark, silver the
// Chrome Rooms one. A theme without its own logo file falls back to the
// original. Asset swap only — no shape or size change.
const THEME_LOGOS = { chromerooms: '/logo_chrome.png' };

export default function Logo({ size = 32, className = '' }) {
  const [theme, setThemeState] = useState(currentTheme());
  useEffect(() => {
    const onTheme = (e) => setThemeState(e.detail || currentTheme());
    window.addEventListener('ciphertheme', onTheme);
    return () => window.removeEventListener('ciphertheme', onTheme);
  }, []);
  const src = THEME_LOGOS[theme] || '/logo_raw.png?v=3';
  return (
    <img
      src={src}
      alt="Cipher Logo"
      width={size}
      height={size}
      className={`object-contain ${className}`}
      draggable={false}
    />
  );
}

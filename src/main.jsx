import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { installStaleShellPrompt } from './lib/staleShell.js'

installStaleShellPrompt(window)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .catch((error) => console.error('[offline] Service worker registration failed:', error));
  }, { once: true });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  
    <App />
  ,
)

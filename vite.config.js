import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The desktop build is the only one that carries the onion group door: the
// page runs under the shell's own Tor, and prepare-pack stages this output
// into the app (electron-builder). Every other build — the web build that
// becomes production, the iPhone build, the browser test build — gets the
// clear address, because a browser cannot reach an onion.
const desktopBuild = process.env.CIPHER_DESKTOP_BUILD === '1'

export default defineConfig({
  plugins: [react()],
  define: {
    __CIPHER_DESKTOP_BUILD__: JSON.stringify(desktopBuild),
  },
  server: {
    host: '0.0.0.0',
    port: 8080,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 8081,
    strictPort: true,
  },
  optimizeDeps: {
    include: ['nostr-tools'],
  },
})

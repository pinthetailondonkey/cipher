import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { stampServiceWorkerFile } from './scripts/stamp-sw.mjs'

// Writes the build id into the shipped service worker's cache name.
function stampServiceWorker() {
  let outDir
  return {
    name: 'stamp-service-worker',
    apply: 'build',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir) },
    closeBundle() { stampServiceWorkerFile(outDir) },
  }
}

export default defineConfig({
  plugins: [react(), stampServiceWorker()],
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

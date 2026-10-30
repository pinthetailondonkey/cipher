import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// The desktop build is the only one that carries the onion group door: the
// page runs under the shell's own Tor, and prepare-pack stages this output
// into the app (electron-builder). Every other build — the web build that
// becomes production, the iPhone build, the browser test build — gets the
// clear address, because a browser cannot reach an onion.
const desktopBuild = process.env.CIPHER_DESKTOP_BUILD === '1'

// The test seam and the test relay wall exist only in a build that never
// ships, and VITE_TEST_HOOKS alone cannot be trusted to say so: it can arrive
// from an untracked env file on a box that is building to deploy. A deliberate
// test build says so twice, and anything else stops here rather than shipping
// a bundle whose relays point at 127.0.0.1.
//
// This guard asks the environment the build will actually use, which is not
// process.env. Vite reads .env, .env.local, .env.[mode] and .env.[mode].local
// and inlines them into import.meta.env; not one of those keys is ever placed
// in process.env. A guard reading process.env therefore answered a different
// question from the one the build answers, and a .env.local carrying the flag
// was inlined by Vite while the guard saw nothing and stayed quiet.
//
// loadEnv is Vite's own reader with an empty prefix, so every key Vite will
// inline is present here, with the process environment folded in on top. One
// merged answer, no filename list to keep in step — a list would have missed
// .env.production.local tomorrow.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  if (env.VITE_TEST_HOOKS === '1' && env.CIPHER_UI_TEST_BUILD !== '1') {
    throw new Error(
      'vite refuses: VITE_TEST_HOOKS is set without CIPHER_UI_TEST_BUILD. '
      + 'The test seam and the test relay wall belong to a build that never ships. '
      + 'Run "npm run build:ui-test" for a test build, or set CIPHER_UI_TEST_BUILD=1 '
      + 'if you are deliberately building one.',
    )
  }

  return {
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
  }
})

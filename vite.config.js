import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// The desktop build is the only one that carries the onion group door: the
// page runs under the shell's own Tor, and prepare-pack stages this output
// into the app (electron-builder). Every other build — the web build that
// becomes production, the iPhone build, the browser test build — gets the
// clear address, because a browser cannot reach an onion.
const desktopBuild = process.env.CIPHER_DESKTOP_BUILD === '1'

// Every file Vite reads into import.meta.env for a production build. A build
// that ships must be the build the repo describes, and a file that is not in
// the repo can change what ships without appearing in any diff.
const VITE_ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local']

// The workspace's own build-flag carrier, merged into the environment by
// scripts/with-app-env.mjs. It is how a desktop build is meant to be given its
// doors, so it is allowed there — and refused everywhere else for the reason
// this whole block exists.
const APP_ENV_FILE = join('.grok', 'app-env.json')

export default defineConfig(({ command, mode }) => {
  // Ask the environment the build will actually use, which is not process.env.
  // Vite reads the env files above and inlines them into import.meta.env; not
  // one of those keys is ever placed in process.env. A guard reading only
  // process.env therefore answered a different question from the one the build
  // answers, and a .env.local carrying the flag was inlined by Vite while the
  // guard saw nothing and stayed quiet.
  //
  // loadEnv is Vite's own reader, and the process environment is folded in on
  // top of it, so this is one merged answer rather than two — and one that no
  // filename list has to keep in step.
  const env = loadEnv(mode, process.cwd(), '')

  if (command === 'build') {
    const present = VITE_ENV_FILES.filter((name) => existsSync(join(process.cwd(), name)))
    if (present.length) {
      throw new Error(
        `vite refuses: ${present.join(', ')} is present. A build is shaped by what is in the repo, `
        + 'and an env file is not: it changes what ships without appearing in any diff. '
        + 'Delete it, or pass the value in the environment for this one command. '
        + '(.env.example is the template and is not read by Vite; it is fine to keep.)',
      )
    }

    if (!desktopBuild && existsSync(join(process.cwd(), APP_ENV_FILE))) {
      throw new Error(
        `vite refuses: ${APP_ENV_FILE} is present and this is not a desktop build. That file is `
        + "merged into every build's environment by scripts/with-app-env.mjs, so it can put a "
        + 'value into a bundle that ships. A desktop build is the one build allowed to carry it.',
      )
    }

    // The test seam and the test relay wall exist only in a build that never
    // ships, and VITE_TEST_HOOKS alone cannot be trusted to say so. A
    // deliberate test build says so twice, and anything else stops here rather
    // than shipping a bundle whose relays point at 127.0.0.1.
    if (env.VITE_TEST_HOOKS === '1' && env.CIPHER_UI_TEST_BUILD !== '1') {
      throw new Error(
        'vite refuses: VITE_TEST_HOOKS is set without CIPHER_UI_TEST_BUILD. '
        + 'The test seam and the test relay wall belong to a build that never ships. '
        + 'Run "npm run build:ui-test" for a test build, or set CIPHER_UI_TEST_BUILD=1 '
        + 'if you are deliberately building one.',
      )
    }
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

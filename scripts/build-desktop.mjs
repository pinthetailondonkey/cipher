#!/usr/bin/env node
// The build the desktop shell packages: the ordinary web build plus the onion
// group door, because the shell runs its own Tor and a browser cannot reach an
// onion at all. It writes to dist-desktop so it can never overwrite the web
// build that becomes production; prepare-pack stages this folder and refuses
// a folder this script did not write.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { readAppEnv } from './with-app-env.mjs';

// The group door's address is not in the repo. A desktop bundle without it
// would take groups off Tor and onto the clear address without a word, so the
// build refuses instead of falling back. The value comes from the untracked
// build file (.grok/app-env.json) through scripts/with-app-env.mjs.
const door = String(process.env.VITE_GROUP_ONION || readAppEnv(process.cwd()).VITE_GROUP_ONION || '').trim();
if (!/^wss:\/\/[a-z2-7]{16,56}\.onion$/.test(door)) {
  console.error('build:desktop refuses: VITE_GROUP_ONION is missing or is not an onion address. The desktop groups would leave Tor. Set it in .grok/app-env.json (untracked).');
  process.exit(1);
}

const child = spawn('node', [
  'scripts/with-app-env.mjs', 'vite', '--config', 'vite.config.js', 'build',
  '--outDir', 'dist-desktop', '--emptyOutDir',
], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, CIPHER_DESKTOP_BUILD: '1' },
});

// The marker is what prepare-pack asks for. A string search for ".onion"
// would not do: every bundle carries it in ordinary URL-parsing code, so a web
// build would pass. A file only this script writes cannot be mistaken.
child.on('exit', (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
    return;
  }
  writeFileSync(
    'dist-desktop/cipher-desktop-build.json',
    `${JSON.stringify({ desktop: true, builtAt: new Date().toISOString() })}\n`,
  );
  process.exit(0);
});

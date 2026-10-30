#!/usr/bin/env node
// The build the browser specs run against: the ordinary build plus the
// window.__cipher test seam (src/db.js), which a shipping build does not carry,
// and the relay wall (src/lib/testRelayOverride.js), so a walk reaches this
// machine and nothing else.
//
// CIPHER_UI_TEST_BUILD is what tells vite.config.js this flag is deliberate.
// Without it the flag is refused outright, so a stray VITE_TEST_HOOKS in an
// untracked env file — .env.local included, which Vite inlines and never puts
// in process.env — cannot put either the seam or the wall into a build that
// ships. The guard reads the merged env for exactly that reason, and
// scripts/vite-config-guard.test.mjs builds through this config to prove it.
import { spawn } from 'node:child_process';

const child = spawn('npm', ['run', 'build'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, VITE_TEST_HOOKS: '1', CIPHER_UI_TEST_BUILD: '1' },
});
child.on('exit', (code) => process.exit(code ?? 1));

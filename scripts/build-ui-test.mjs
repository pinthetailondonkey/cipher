#!/usr/bin/env node
// The build the browser specs run against: the ordinary build plus the
// window.__cipher test seam (src/db.js), which a shipping build does not carry.
import { spawn } from 'node:child_process';

const child = spawn('npm', ['run', 'build'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, VITE_TEST_HOOKS: '1' },
});
child.on('exit', (code) => process.exit(code ?? 1));

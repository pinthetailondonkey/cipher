#!/usr/bin/env node
import { spawn } from 'node:child_process';

const configuredRelays = String(process.env.VITE_PROTOCOL_TEST_RELAYS || '').trim();
if (!configuredRelays) {
  console.error('Set VITE_PROTOCOL_TEST_RELAYS to one or more explicit local relay URLs, for example ws://127.0.0.1:18888.');
  process.exit(2);
}

const child = spawn('npm', ['run', 'build'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    VITE_TEST_HOOKS: '1',
    CIPHER_UI_TEST_BUILD: '1',
    VITE_PROTOCOL_TEST_MODE: '1',
    VITE_PROTOCOL_TEST_DM: process.env.VITE_PROTOCOL_TEST_DM || '0',
    VITE_PROTOCOL_TEST_MLS: process.env.VITE_PROTOCOL_TEST_MLS || '0',
    CIPHER_PROTOCOL_TEST_BUILD: '1',
  },
});
child.on('error', (error) => { console.error(error); process.exit(127); });
child.on('exit', (code) => process.exit(code ?? 1));

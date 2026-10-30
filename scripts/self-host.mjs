import { spawn } from 'node:child_process';

function run(args) {
  return new Promise((resolve) => {
    const child = spawn('node', args, { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

// The mirror binds the machine itself, so the way to serve it outward is an
// onion service on the system tor — on Tails especially, where a second tor
// client would fight the one that is already running.
const onionPort = process.env.TOR_ONION_PORT || '80';
console.log('[mirror] To serve the mirror as an onion service, add to torrc:');
console.log('[mirror]   HiddenServiceDir /var/lib/tor/cipher-mirror/');
console.log(`[mirror]   HiddenServicePort ${onionPort} 127.0.0.1:${process.env.PORT || '8080'}`);
console.log('[mirror] then reload tor; open the .onion name from that directory\'s hostname file in Tor Browser.');

const built = await run(['scripts/with-app-env.mjs', 'vite', '--config', 'vite.config.js', 'build']);
if (built) process.exit(built);
const port = process.env.PORT || '8080';
const served = await run([
  'scripts/with-app-env.mjs',
  'vite',
  '--config',
  'vite.config.js',
  'preview',
  '--host',
  '127.0.0.1',
  '--port',
  port,
  '--strictPort',
]);
process.exit(served);

import { spawn } from 'node:child_process';

function run(args) {
  return new Promise((resolve) => {
    const child = spawn('node', args, { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

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
  '0.0.0.0',
  '--port',
  port,
  '--strictPort',
]);
process.exit(served);

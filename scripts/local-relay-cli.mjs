#!/usr/bin/env node
// TEST/DEV-ONLY local relay launcher for human testing of the test-profile DM
// lane; not production infrastructure.
import { createLocalNip01Relay } from './local-nip01-relay.mjs';

function parseArgs(argv) {
  const args = { host: '127.0.0.1', port: 7777, printUrl: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--port') {
      index += 1;
      const value = argv[index];
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        process.stderr.write(`--port must be an integer between 0 and 65535, got: ${value}\n`);
        process.exit(2);
      }
      args.port = port;
    } else if (flag === '--host') {
      index += 1;
      args.host = argv[index];
    } else if (flag === '--print-url') {
      args.printUrl = true;
    } else {
      process.stderr.write(`Unknown argument: ${flag}\n`);
      process.stderr.write('Usage: node scripts/local-relay-cli.mjs [--host 127.0.0.1] [--port 7777] [--print-url]\n');
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!['127.0.0.1', 'localhost', '::1'].includes(args.host)) {
  process.stderr.write(`Refusing non-loopback host: ${args.host}. This relay binds to loopback only.\n`);
  process.exit(2);
}

const relay = await createLocalNip01Relay({ host: args.host, port: args.port });

if (args.printUrl) {
  process.stdout.write(`${relay.url}\n`);
} else {
  process.stderr.write(`on ${relay.url} ready\n`);
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await relay.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

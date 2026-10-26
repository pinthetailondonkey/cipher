import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

// Desktop code is CommonJS (electron's main); tests read it without electron.
const require = createRequire(import.meta.url);
const { buildTorArgs, parseOsRelease, randomSocksPort, socksPortFromTorrc } = require('../src/tor.js');

test('tor args serve socks on the loopback port with a temporary data dir', () => {
  assert.deepEqual(
    buildTorArgs('/tmp/cipher-tor-abc123', 9050),
    ['--SocksPort', '127.0.0.1:9050', '--DataDirectory', '/tmp/cipher-tor-abc123'],
  );
  assert.deepEqual(
    buildTorArgs('/tmp/other', 12345),
    ['--SocksPort', '127.0.0.1:12345', '--DataDirectory', '/tmp/other'],
  );
});

test('os-release says tails only when the ID line is tails', () => {
  const isTails = [
    'ID=tails\n',
    'ID="tails"\n',
    "ID='tails'\n",
    'ID=tails\r\n',
    'NAME=Tails\nID=tails\nHOME_URL=https://tails.net\n',
    'ID=tails\nVERSION="6.0"\n',
  ];
  for (const text of isTails) assert.equal(parseOsRelease(text), true, JSON.stringify(text));

  const isNotTails = [
    'ID=debian\n',
    'ID_LIKE=debian\n',
    'ID=""\n',
    'ID=tailsy\n',
    'ID=tails something\n',
    'XID=tails\n',
    '# ID=tails commented out\nID=debian\n',
    '\n',
    '',
  ];
  for (const text of isNotTails) assert.equal(parseOsRelease(text), false, JSON.stringify(text));

  assert.equal(parseOsRelease(undefined), false);
  assert.equal(parseOsRelease(null), false);
});

test('randomSocksPort lands in the unprivileged range every time', () => {
  for (let i = 0; i < 100; i += 1) {
    const p = randomSocksPort();
    assert.equal(Number.isInteger(p), true);
    assert.ok(p >= 10000 && p <= 65535, `port ${p} out of range`);
    assert.notEqual(p, 9050); // the locked default port of the route
  }
});

test('torrc hands over the first loopback SocksPort and nothing else', () => {
  // Tails' shipped torrc shape: the general SocksPort plus internal-only
  // ports and options the app must never touch.
  assert.equal(socksPortFromTorrc(
    'SocksPort 127.0.0.1:9050 IsolateDestAddr IsolateDestPort\n'
    + 'SocksPort 127.0.0.1:9062\n'
    + 'ControlPort unix:/var/run/tor/control\n',
  ), 9050);

  // A different configured port is honored (the file is the truth).
  assert.equal(socksPortFromTorrc('SocksPort 127.0.0.1:9150\n'), 9150);
  // Bare SocksPort (no address) and non-loopback lines do not count.
  assert.equal(socksPortFromTorrc('SocksPort 9050\n'), null);
  assert.equal(socksPortFromTorrc('SocksPort 10.200.1.1:9050\n'), null);
  // Comments and junk are skipped; empty or non-string input is null.
  assert.equal(socksPortFromTorrc('# SocksPort 127.0.0.1:9050\n'), null);
  assert.equal(socksPortFromTorrc(''), null);
  assert.equal(socksPortFromTorrc(undefined), null);
});

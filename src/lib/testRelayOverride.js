// The test build's relay wall — a file of addresses on this machine, never a
// hostname and never an environment variable. A door is a file for a reason
// (see egress.js): an env var once bought a silent clearnet build, and a relay
// key would walk straight back into that hole.
//
// This module is imported under a build-time literal, so Rollup drops it from
// every build that does not set VITE_TEST_HOOKS=1. A node test proves it is
// ABSENT from a production bundle rather than merely unused.
//
// Every address is 127.0.0.1 on a port nothing listens on: a walk that dials
// one fails at connect, at once, on this machine. That is the point — a walk
// nobody asked to reach a public relay must fail loudly instead of leaving.
//
// The wall has one gate and this comment is where it is: the four dynamic rows
// (pictures, profile photos, name lookup, nip05) point at whatever host a
// message or a name names, so they cannot be overridden. A walk that loads a
// picture still reaches that picture's host.
//
// Rows that ship empty (a watcher, a push gateway) stay empty: a walk that
// pastes neither still dials nothing.

// A string no other build carries, so a test can grep a bundle for it. It is
// deliberately not a hostname.
export const TEST_RELAY_OVERRIDE_MARK = 'cipher-test-relay-wall';

const RELAY = 'ws://127.0.0.1:9';
const HOST = 'http://127.0.0.1:9';

export const TEST_RELAY_OVERRIDE = {
  'group-relay': RELAY,
  'dm-relay': RELAY,
  'profile-nos': RELAY,
  'profile-damus': RELAY,
  'profile-purple': RELAY,
  'search-vertex': RELAY,
  'search-noswhere': RELAY,
  'blossom-primal': HOST,
  'blossom-nostr-build': HOST,
  'blossom-band': HOST,
  'link-preview': HOST,
  'dead-drop': HOST,
  'app-host': HOST,
};

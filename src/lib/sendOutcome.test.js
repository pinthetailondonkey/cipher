import test from 'node:test';
import assert from 'node:assert/strict';
import { sendOutcome } from './sendOutcome.js';

// The four callers of the composer show a success toast only for 'sent'.
// These are the answers a send can come back with, including the two that
// used to be indistinguishable from success at the call site.

test('a send with a relay event is sent', () => {
  assert.equal(sendOutcome({ success: true, event: { id: 'abc' } }), 'sent');
  assert.equal(sendOutcome({ success: true, queued: true, event: { id: 'abc' } }), 'sent');
});

test('success without an event is not sent', () => {
  assert.equal(sendOutcome({ success: true }), 'failed');
  assert.equal(sendOutcome({ success: true, event: {} }), 'failed');
});

test('a refused send is failed, never sent', () => {
  assert.equal(sendOutcome({ success: false, error: 'rejected' }), 'failed');
  assert.equal(sendOutcome({ success: false, error: 'Failed to send: rejected' }), 'failed');
});

test('a timed-out send is failed, never sent', () => {
  assert.equal(sendOutcome({ success: false, error: 'timeout' }), 'failed');
  assert.equal(sendOutcome({ success: false, error: 'Timed out' }), 'failed');
});

test('a group message waiting on a key is securing, not failed and not sent', () => {
  assert.equal(sendOutcome({ success: false, error: 'NO_KEY' }), 'securing');
});

test('nothing at all is failed', () => {
  assert.equal(sendOutcome(undefined), 'failed');
  assert.equal(sendOutcome(null), 'failed');
  assert.equal(sendOutcome({}), 'failed');
});

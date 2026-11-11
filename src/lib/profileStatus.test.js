import assert from 'node:assert/strict';
import test from 'node:test';
import { STATUS_MAX, sanitizeStatus } from './profileStatus.js';

test('status keeps visible text and trims the edges', () => {
  assert.equal(sanitizeStatus('  vibing  '), 'vibing');
  assert.equal(sanitizeStatus('🫠 crypto mode'), '🫠 crypto mode');
});

test('status strips control characters to spaces, not holes', () => {
  assert.equal(sanitizeStatus('a\u0000b\u0007c'), 'a b c');
});

test('status collapses whitespace runs', () => {
  assert.equal(sanitizeStatus('one\t  two\n\nthree'), 'one two three');
});

test('status caps length for the name plate', () => {
  const long = 'x'.repeat(STATUS_MAX + 40);
  assert.equal(sanitizeStatus(long).length, STATUS_MAX);
});

test('status of nothing is an empty string, never undefined', () => {
  assert.equal(sanitizeStatus(''), '');
  assert.equal(sanitizeStatus(null), '');
  assert.equal(sanitizeStatus(undefined), '');
});

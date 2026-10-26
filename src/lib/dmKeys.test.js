import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationKey, clearConversationKeyCache, _setDeriverForTest } from './dmKeys.js';

const derivations = [];
const restore = _setDeriverForTest((sk, pk) => {
  derivations.push(`${sk}:${pk}`);
  return new Uint8Array(32).fill(derivations.length);
});

test.after(() => restore());

test('the same secret-peer pair derives once and returns the same bytes', () => {
  clearConversationKeyCache();
  derivations.length = 0;
  const a = conversationKey('aa', 'peer1');
  const b = conversationKey('aa', 'peer1');
  assert.equal(a, b);
  assert.equal(derivations.length, 1);
});

test('a different peer or secret derives its own key', () => {
  clearConversationKeyCache();
  derivations.length = 0;
  conversationKey('aa', 'peer1');
  conversationKey('aa', 'peer2');
  conversationKey('bb', 'peer1');
  assert.equal(derivations.length, 3);
});

test('the cache holds a bounded number of pairs', () => {
  clearConversationKeyCache();
  derivations.length = 0;
  for (let i = 0; i < 80; i += 1) conversationKey('aa', `peer${i}`);
  // The oldest pairs were evicted: asking again derives again.
  const before = derivations.length;
  conversationKey('aa', 'peer0');
  assert.equal(derivations.length, before + 1);
});

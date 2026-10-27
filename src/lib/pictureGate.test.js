import assert from 'node:assert/strict';
import test from 'node:test';
import { pictureHost, pictureIsGated } from './pictureGate.js';

// These run in node, where navigator does not exist — the honest
// plain-browser stance — so the gate is exactly the clearnet test.
test('a picture from a clearnet host is gated; onion and app-own bytes are not', () => {
  assert.equal(pictureIsGated('https://bloomor.example/pic.jpg'), true);
  assert.equal(pictureIsGated('http://plain.example/avatar.png'), true);
  assert.equal(pictureIsGated('https://amollyenvvmqyxruju5nclqq5egmmyv6fsggboer7v7x3blpjef5did.onion/pic'), false);
  assert.equal(pictureIsGated('data:image/png;base64,AAAA'), false, 'data URLs are bytes the app already owns');
  assert.equal(pictureIsGated(''), false);
  assert.equal(pictureIsGated('blob:http://127.0.0.1/x'), false, 'loopback bytes carry nothing out');

  assert.equal(pictureHost('https://bloomor.example/pic.jpg'), 'bloomor.example');
  assert.equal(pictureHost('/relative.png', 'https://app.example/'), 'app.example');
  assert.equal(pictureHost('not a url'), '');
});

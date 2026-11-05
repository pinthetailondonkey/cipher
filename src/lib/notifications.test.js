import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { allowsNotifications, setPrivacy } from './privacy.js';
import { requestNotificationPermission, resetNotificationGate, showNotification } from './notifications.js';

// A localStorage in memory: privacy settings live there.
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  key: (index) => Array.from(memory.keys())[index] || null,
  get length() { return memory.size; },
};
// The session and the scoped writes read the active account; one is enough.
localStorage.setItem('cipher_active_pubkey', 'ab'.repeat(32));

// A browser-shaped window with a Notification whose grant is scripted, so the
// prompt count is observable. Nothing here is a real browser.
function stubBrowser(initial = 'default', answer = 'granted') {
  const calls = { prompt: 0 };
  let permission = initial;
  const shown = [];
  class FakeNotification {
    constructor(...args) { shown.push(args); }
    static get permission() { return permission; }
    static async requestPermission() {
      calls.prompt += 1;
      permission = answer;
      return answer;
    }
  }
  globalThis.window = globalThis;
  globalThis.Notification = FakeNotification;
  globalThis.document = { visibilityState: 'hidden' };
  return { calls, shown };
}

// fix 7: the OS prompt is a user gesture's job, never the mount's. Intent
// (the privacy setting) and ability (the OS grant) are separate: a message
// does not buzz on a grant alone, and a refusal never reads as enabled.
test('a buzz needs the person to have asked, not just the OS grant', async () => {
  const browser = stubBrowser('granted');
  setPrivacy({ notifications: false });
  resetNotificationGate();
  await showNotification('message', 'peer-1');
  assert.equal(browser.shown.length, 0, 'a granted OS permission alone does not buzz');
  setPrivacy({ notifications: true });
  resetNotificationGate();
  await showNotification('message', 'peer-1');
  assert.equal(browser.shown.length, 1, 'the intent is what turns the buzz on');
  setPrivacy({ notifications: false });
});

test('the permission is asked only by the explicit action', async () => {
  const browser = stubBrowser('default', 'granted');
  assert.equal(browser.calls.prompt, 0, 'nothing asks on import');
  assert.equal(await requestNotificationPermission(), true);
  assert.equal(browser.calls.prompt, 1, 'the action asks exactly once');
  // A second visit with the grant in hand does not prompt again.
  assert.equal(await requestNotificationPermission(), true);
  assert.equal(browser.calls.prompt, 1);
});

test('a denial leaves the switch off and never claims it was granted', async () => {
  const browser = stubBrowser('default', 'denied');
  assert.equal(await requestNotificationPermission(), false);
  assert.equal(browser.calls.prompt, 1);
  // A decided refusal is not re-asked; the browser would not show it anyway.
  assert.equal(await requestNotificationPermission(), false);
  assert.equal(browser.calls.prompt, 1, 'a denied permission does not prompt again');
});

test('an unsupported device answers false without throwing', async () => {
  const savedNotification = globalThis.Notification;
  delete globalThis.Notification;
  assert.equal(await requestNotificationPermission(), false);
  globalThis.Notification = savedNotification;
});

test('the app no longer asks for permission when the authenticated shell mounts', () => {
  const app = fs.readFileSync(new URL('../AuthenticatedApp.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /requestNotificationPermission/, 'the mount no longer owns the prompt');
  const settings = fs.readFileSync(new URL('../components/chat/PrivacySettings.jsx', import.meta.url), 'utf8');
  assert.match(settings, /requestNotificationPermission\(\)/, 'the settings toggle asks it');
  assert.match(settings, /update\(\{ notifications: false \}\)/, 'a refusal writes the setting back to off');
  assert.match(settings, /update\(\{ notifications: true \}\)/, 'only a grant turns the setting on');
  assert.equal(allowsNotifications(), false, 'opt-in is off by default');
});

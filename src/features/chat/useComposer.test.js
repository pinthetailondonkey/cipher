import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('./useComposer.js', import.meta.url), 'utf8').replace(/\s+/g, ' ');

test('composer captures one account incarnation and checks around durable and network awaits', () => {
  const send = SOURCE.slice(SOURCE.indexOf('const sendMessage = async'), SOURCE.indexOf('const handleImageUpload'));
  assert.match(send, /const securityFence = assertCurrent\(\)/);
  assert.match(send, /await saveMessage\(activeGroup\.id, newMsg\); assertCurrent\(securityFence\)/);
  assert.match(send, /await sendGroupMessage\([\s\S]*?\); assertCurrent\(securityFence\)/);
  assert.match(send, /await sendDM\([\s\S]*?\); assertCurrent\(securityFence\)/);
  assert.match(send, /await saveMessage\(activeDm, confirmedMessage[\s\S]*?\); assertCurrent\(securityFence\)/);
});

test('photo and voice work stop local effects after their captured incarnation expires', () => {
  const photo = SOURCE.slice(SOURCE.indexOf('const handleImageUpload'), SOURCE.indexOf('const startRecording'));
  assert.match(photo, /let securityFence; try \{ securityFence = assertCurrent\(\)/);
  assert.match(photo, /await sendPrivateImage\([\s\S]*?\); assertCurrent\(securityFence\)/);
  assert.match(photo, /if \(securityFence\.isCurrent\(\)\) setToast/);
  assert.match(photo, /if \(securityFence\.isCurrent\(\)\) setUploadingImage\(false\)/);

  const voice = SOURCE.slice(SOURCE.indexOf('const startRecording'), SOURCE.indexOf('return { sendMessage'));
  assert.match(voice, /await navigator\.mediaDevices\.getUserMedia\([\s\S]*?if \(!chatMountedRef\.current \|\| !securityFence\.isCurrent\(\)\)/);
  assert.match(voice, /await uploadPrivateMedia\([\s\S]*?\); assertCurrent\(securityFence\)/);
  assert.match(voice, /if \(chatMountedRef\.current && securityFence\.isCurrent\(\)\) setUploadingImage\(false\)/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingSession } from './recordingSession.js';

// A real Blob, so the size assertions measure what the recorder would hand
// over rather than a stand-in object's shape.
const chunk = (size) => new Blob([new Uint8Array(size)]);

test('a cancelled recording never sends, even after a new one starts', () => {
  const first = createRecordingSession();
  first.addChunk(chunk(10));
  first.cancel();

  // The person starts a second recording before the first onstop runs.
  const second = createRecordingSession();
  first.supersede();

  assert.equal(first.shouldSend(), false);
  assert.equal(first.blob('audio/webm').size, 0);
  assert.equal(second.shouldSend(), true);
});

test('a shared flag would have revived it: the ordering that used to upload', () => {
  const first = createRecordingSession();
  first.addChunk(chunk(10));
  first.cancel();
  // Cancelling is not undone by anything a later session does.
  first.supersede();
  first.addChunk(chunk(5));
  assert.equal(first.shouldSend(), false);
  assert.equal(first.blob('audio/webm').size, 0);
});

test('a superseded recording sends nothing but is not reported as cancelled', () => {
  const first = createRecordingSession();
  first.addChunk(chunk(8));
  first.supersede();
  assert.equal(first.shouldSend(), false);
  assert.equal(first.blob('audio/webm').size, 0);
});

test('a clean recording keeps its audio until the send decides', () => {
  const session = createRecordingSession();
  session.addChunk(chunk(4));
  session.addChunk(new Blob([]));
  session.addChunk(chunk(6));
  assert.equal(session.shouldSend(), true);
  assert.equal(session.blob('audio/webm').size, 10);
});

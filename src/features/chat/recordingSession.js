// One recording, one answer about whether its audio may leave the device.
//
// A MediaRecorder's onstop fires after stop() is called, and it fires even for
// a recording the person threw away. A single shared "cancelled" flag gets
// this wrong: cancel session A, start session B, and B clears the flag before
// A's onstop runs — so A's discarded audio uploads. Cancellation therefore
// belongs to the session, and a newer session supersedes an older one rather
// than resetting it.

export function createRecordingSession() {
  const state = { cancelled: false, superseded: false, chunks: [] };
  return {
    // Throwing the recording away drops its audio at once.
    cancel() {
      state.cancelled = true;
      state.chunks = [];
    },
    // A new recording has taken the microphone and the composer. The older
    // session is not cancelled by the person, but it must still send nothing.
    supersede() {
      state.superseded = true;
      state.chunks = [];
    },
    addChunk(data) {
      if (state.cancelled || state.superseded) return;
      if (data && data.size > 0) state.chunks.push(data);
    },
    // The one question onstop asks before uploading anything.
    shouldSend() {
      return !state.cancelled && !state.superseded;
    },
    blob(type) {
      return new Blob(state.chunks, { type });
    },
  };
}

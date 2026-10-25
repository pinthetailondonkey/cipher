// Panic wipe fires on three hard jolts inside one second. Gravity is
// included in the readings, so a phone being carried or set down stays well
// under the threshold. Nothing counts until armAt, so the tap that turned
// the setting on cannot set it off.
export function createShakeDetector({ threshold = 35, spikes = 3, windowMs = 1000, minIntervalMs = 50, armAt = 0 } = {}) {
  let last = null;
  let lastTime = 0;
  let count = 0;
  let lastSpike = 0;
  return function feed(reading, now = Date.now()) {
    if (now < armAt || !reading) return false;
    const { x, y, z } = reading;
    if (x == null || y == null || z == null) return false;
    if (now - lastTime < minIntervalMs) return false;
    lastTime = now;
    const previous = last;
    last = { x, y, z };
    if (!previous) return false;
    const magnitude = Math.abs(x - previous.x) + Math.abs(y - previous.y) + Math.abs(z - previous.z);
    if (magnitude <= threshold) return false;
    if (now - lastSpike > windowMs) count = 0;
    count += 1;
    lastSpike = now;
    return count >= spikes;
  };
}

// iOS asks for motion access, and only inside a tap. Elsewhere it is open.
export async function requestMotionAccess() {
  const Motion = globalThis.DeviceMotionEvent;
  if (!Motion) return 'unsupported';
  if (typeof Motion.requestPermission !== 'function') return 'granted';
  try {
    return await Motion.requestPermission();
  } catch {
    return 'denied';
  }
}

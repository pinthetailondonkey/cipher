export function parseProtocolTestRelays(raw) {
  const values = String(raw || '').split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  const endpoints = [];
  for (const value of values) {
    let url;
    try { url = new URL(value); } catch { throw new Error(`invalid URL: ${value}`); }
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !url.port || Number(url.port) < 1 || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error(`not a loopback WebSocket endpoint with an explicit port: ${value}`);
    }
    const endpoint = `ws://${url.hostname}:${url.port}`;
    if (!endpoints.includes(endpoint)) endpoints.push(endpoint);
  }
  return endpoints;
}

export function validateProtocolTestBuild({ env = {}, desktopBuild = false } = {}) {
  for (const key of ['VITE_PROTOCOL_TEST_DM', 'VITE_PROTOCOL_TEST_MLS']) {
    if (env[key] !== undefined && !['0', '1'].includes(env[key])) {
      throw new Error(`${key} must be 0 or 1.`);
    }
    if (env[key] === '1') {
      throw new Error(`${key} cannot be enabled until that isolated protocol path has passed its separate review gate.`);
    }
  }
  const flag = env.VITE_PROTOCOL_TEST_MODE === '1';
  const buildFlag = env.CIPHER_PROTOCOL_TEST_BUILD === '1';
  const hasConfig = Boolean(String(env.VITE_PROTOCOL_TEST_RELAYS || '').trim());
  if (flag !== buildFlag || (hasConfig && !buildFlag)) {
    throw new Error('protocol test mode needs both build flags, and relay configuration is forbidden in a normal build');
  }
  if (!buildFlag) return { enabled: false, relays: [] };
  if (desktopBuild || env.VITE_TEST_HOOKS !== '1' || env.CIPHER_UI_TEST_BUILD !== '1') {
    throw new Error('protocol test mode requires the dedicated browser test build and cannot be a desktop or shipping build');
  }
  const relays = parseProtocolTestRelays(env.VITE_PROTOCOL_TEST_RELAYS);
  if (!relays.length) throw new Error('protocol test mode requires an explicit local relay allowlist');
  return { enabled: true, relays };
}

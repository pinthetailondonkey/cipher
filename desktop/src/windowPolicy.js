'use strict';
// What a window may do, kept apart from electron so plain node can test it.
// Design: docs/DESKTOP.md. The shell has one page, the loopback UI server.
// Anything else - a link a stranger posted, a redirect, a pop-up - must not
// become a second page inside a window that carries the Tor route and the
// user's keys. External links are denied outright: opening them would hand
// the address to the system browser, outside Tor.

// True only for the exact UI origin: http://127.0.0.1:<uiPort>. Both
// 'localhost' and other ports are different origins on purpose; the proxy
// bypass list (src/main.js) covers 127.0.0.1:<uiPort> and nothing else.
function isUiUrl(url, uiPort) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === String(uiPort)
    && u.username === '' && u.password === '';
}

// Wire one webContents. Called for every webContents electron creates, so a
// window made later gets the same locks as the first.
//   - window.open / target=_blank: denied, nothing opens.
//   - navigation or redirect away from the UI origin: cancelled.
//   - <webview> attach: cancelled (the UI never uses one).
//   - WebRTC: disable_non_proxied_udp unless the dev hatch is set.
function applyWindowPolicy(contents, { uiPort, allowCalls = false }) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (event, url) => {
    if (!isUiUrl(url, uiPort)) event.preventDefault();
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  if (!allowCalls) contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
}

module.exports = { isUiUrl, applyWindowPolicy };

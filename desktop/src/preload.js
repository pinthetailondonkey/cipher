'use strict';
// The only bridge between the page and the desktop's device key. It exposes
// five asks and nothing else; the secret itself stays in the main process
// (src/deviceKey.js). The window runs sandboxed with context isolation, and
// this file is the preload that keeps both true.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cipherDeviceKey', {
  available: () => ipcRenderer.invoke('cipher-device-key:available'),
  enroll: (pk, options) => ipcRenderer.invoke('cipher-device-key:enroll', pk, options),
  seal: (pk, id, plain, aad) => ipcRenderer.invoke('cipher-device-key:seal', pk, id, plain, aad),
  open: (pk, id, blob, aad) => ipcRenderer.invoke('cipher-device-key:open', pk, id, blob, aad),
  has: (pk) => ipcRenderer.invoke('cipher-device-key:has', pk),
  destroy: (pk) => ipcRenderer.invoke('cipher-device-key:destroy', pk),
});

'use strict';
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

const listeners = new Map();
ipcRenderer.on('event', (_e, channel, payload) => {
  for (const fn of listeners.get(channel) || []) { try { fn(payload); } catch (err) { console.error(err); } }
});

contextBridge.exposeInMainWorld('mcl', {
  call: (method, ...args) => ipcRenderer.invoke('call', method, args),
  on: (channel, fn) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    return () => listeners.get(channel).delete(fn);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  setZoom: (f) => webFrame.setZoomFactor(Math.min(1.4, Math.max(0.8, Number(f) || 1))),
});

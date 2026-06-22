// preload.js — the ONLY bridge between the Rio renderer and the main process.
// contextIsolation is on; we expose a small, named, audited surface.
const { contextBridge, ipcRenderer } = require('electron');

function sub(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('rio', {
  // main -> renderer (subscriptions; each returns an unsubscribe fn)
  onTick:    (cb) => sub('rio:tick', cb),       // {cx, cy, speed} cursor in window CSS px
  onState:   (cb) => sub('rio:state', cb),      // {state, facing, mood, bubble, ...}
  onConfig:  (cb) => sub('rio:config', cb),     // {scale, mute, name, w, h, dpr}
  onCommand: (cb) => sub('rio:command', cb),    // one-shot: {name, data}

  // renderer -> main
  ready:        () => ipcRenderer.send('rio:ready'),
  reportHitbox: (rect) => ipcRenderer.send('rio:hitbox', rect),
  dragStart:    () => ipcRenderer.send('rio:drag-start'),
  dragEnd:      () => ipcRenderer.send('rio:drag-end'),
  action:       (name, data) => ipcRenderer.send('rio:action', { name, data }),

  // request/response
  getConfig: () => ipcRenderer.invoke('rio:get-config'),
});

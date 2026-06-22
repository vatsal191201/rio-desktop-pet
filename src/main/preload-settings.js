const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rioSettings', {
  get: () => ipcRenderer.invoke('rio:settings-get'),
  set: (patch) => ipcRenderer.invoke('rio:settings-set', patch),
  grantAccess: () => ipcRenderer.invoke('rio:grant-access'),
  openExternal: (url) => ipcRenderer.send('rio:open-external', url),
});

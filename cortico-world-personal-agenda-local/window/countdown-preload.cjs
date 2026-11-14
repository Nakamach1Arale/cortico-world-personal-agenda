const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('countdown', {
  get: () => ipcRenderer.invoke('countdown:get'),
  action: (command, value) => ipcRenderer.invoke('countdown:action', command, value),
  subscribe: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('countdown:snapshot', listener);
    return () => ipcRenderer.removeListener('countdown:snapshot', listener);
  },
});

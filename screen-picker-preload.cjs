const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('regionPicker', {
  anchor: point => ipcRenderer.invoke('screen-window-anchor', point),
  source: box => ipcRenderer.invoke('screen-region-source', box),
  finish: accepted => ipcRenderer.invoke('screen-region-picked', accepted),
});

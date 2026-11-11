const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('assistant', {
  configure: input => ipcRenderer.invoke('configure', input),
  transcribe: bytes => ipcRenderer.invoke('transcribe', bytes),
  answer: input => ipcRenderer.invoke('answer', input),
  cancel: () => ipcRenderer.invoke('cancel'),
  cancelAnswer: () => ipcRenderer.invoke('cancel-answer'),
  controlWindow: action => ipcRenderer.invoke('window-control', action),
  setAnswerShortcut: shortcut => ipcRenderer.invoke('set-answer-shortcut', shortcut),
  setSystemPrompt: prompt => ipcRenderer.invoke('set-system-prompt', prompt),
  selectScreenRegion: () => ipcRenderer.invoke('select-screen-region'),
  readScreenRegion: () => ipcRenderer.invoke('read-screen-region'),
  stopScreenRegion: () => ipcRenderer.invoke('stop-screen-region'),
  copyText: text => ipcRenderer.invoke('copy-text', text),
  info: () => ipcRenderer.invoke('info'),
  onDelta: callback => ipcRenderer.on('answer-delta', (_, value) => callback(value)),
  onShortcut: callback => ipcRenderer.on('answer-shortcut', () => callback()),
});

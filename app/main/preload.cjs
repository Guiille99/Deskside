// Puente mínimo: el renderer no tiene Node ni ipcRenderer, solo estas funciones. CJS porque el preload corre con sandbox.
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => { ipcRenderer.on(ch, (_e, data) => cb(data)); };
contextBridge.exposeInMainWorld('office', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  projects: () => ipcRenderer.invoke('projects'),
  setPolicy: (id, status) => ipcRenderer.invoke('set-policy', id, status),
  hook: () => ipcRenderer.invoke('hook'),
  hookApply: (action) => ipcRenderer.invoke('hook-apply', action),
  onDelta: on('delta'),
  onStatus: on('status'),
  onProjects: on('projects'),
});

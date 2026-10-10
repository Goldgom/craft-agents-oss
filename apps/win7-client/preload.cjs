'use strict'
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('TokenBirdRemote', {
  getConnection: () => ipcRenderer.invoke('remote:get-connection'),
  configureServer: () => ipcRenderer.invoke('remote:configure'),
  openExternal: url => ipcRenderer.invoke('remote:open-external', url),
  connect: input => ipcRenderer.invoke('remote:connect', input),
})

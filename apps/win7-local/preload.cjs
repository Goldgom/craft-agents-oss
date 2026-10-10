'use strict'
const { contextBridge, ipcRenderer } = require('electron')
const events = new Set(['systemTheme', 'windowFocus', 'closeRequested', 'notificationNavigate',
  'menuNewChat', 'menuOpenSettings', 'menuKeyboardShortcuts', 'menuToggleFocusMode', 'menuToggleSidebar', 'deepLinkNavigate', 'badgeDrawWindows'])
contextBridge.exposeInMainWorld('TokenBirdDesktop', {
  versions: { node: process.versions.node, chrome: process.versions.chrome, electron: process.versions.electron },
  invoke: (method, ...args) => ipcRenderer.invoke('desktop:invoke', method, ...args),
  on: (event, callback) => {
    if (!events.has(event)) throw new Error('Unknown desktop event')
    const handler = (_event, kind, ...args) => { if (kind === event) callback(...args) }
    ipcRenderer.on('desktop:event', handler)
    return () => ipcRenderer.removeListener('desktop:event', handler)
  },
  // Electron 22 predates webUtils; File.path is its native OS drag/drop API.
  getFilePath: file => typeof file?.path === 'string' && file.path ? file.path : null,
})
contextBridge.exposeInMainWorld('TokenBirdRemote', {
  getConnection: () => ipcRenderer.invoke('local:get-connection'),
  configureServer: () => ipcRenderer.invoke('local:show-settings'),
  openExternal: url => ipcRenderer.invoke('local:open-external', url),
})

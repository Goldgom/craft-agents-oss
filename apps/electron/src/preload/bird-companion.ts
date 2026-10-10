import { contextBridge, ipcRenderer } from 'electron'
import { BIRD_COMPANION_IPC as IPC, type BirdCompanionState, type BirdWindowRole } from '../shared/bird-companion'

contextBridge.exposeInMainWorld('birdCompanion', {
  role: (process.argv.includes('--bird-companion-role=bubble') ? 'bubble' : 'bird') as BirdWindowRole,
  onState(callback: (state: BirdCompanionState) => void) {
    const listener = (_event: Electron.IpcRendererEvent, state: BirdCompanionState) => callback(state)
    ipcRenderer.on(IPC.state, listener)
    return () => ipcRenderer.removeListener(IPC.state, listener)
  },
  ready: () => ipcRenderer.invoke(IPC.ready),
  getState: () => ipcRenderer.invoke(IPC.getState),
  dismissBubble: () => ipcRenderer.invoke(IPC.dismissBubble),
  showBubble: () => ipcRenderer.invoke(IPC.showBubble),
  resizeBubble: (height: number) => ipcRenderer.invoke(IPC.resizeBubble, height),
  interactive: (value: boolean) => ipcRenderer.invoke(IPC.interactive, value),
  move: (x: number, y: number) => ipcRenderer.invoke(IPC.move, { x, y }),
})

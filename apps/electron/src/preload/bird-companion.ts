import { contextBridge, ipcRenderer } from 'electron'
import { BIRD_COMPANION_IPC as IPC, type BirdCompanionState } from '../shared/bird-companion'

contextBridge.exposeInMainWorld('birdCompanion', {
  onState(callback: (state: BirdCompanionState) => void) {
    const listener = (_event: Electron.IpcRendererEvent, state: BirdCompanionState) => callback(state)
    ipcRenderer.on(IPC.state, listener)
    return () => ipcRenderer.removeListener(IPC.state, listener)
  },
  ready: () => ipcRenderer.invoke(IPC.ready),
  getState: () => ipcRenderer.invoke(IPC.getState),
  dismiss: () => ipcRenderer.invoke(IPC.dismiss),
  interactive: (value: boolean) => ipcRenderer.invoke(IPC.interactive, value),
  move: (x: number, y: number) => ipcRenderer.invoke(IPC.move, { x, y }),
})

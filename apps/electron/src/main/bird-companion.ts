import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { loadPreferences, updatePreferences } from '@craft-agent/shared/config/preferences'
import { i18n } from '@craft-agent/shared/i18n'
import { mainLog } from './logger'
import { BirdCompanionProgress } from './bird-companion-progress'
import {
  BIRD_COMPANION_IPC as IPC,
  toBirdProgressEvent, type BirdCompanionPreferences, type BirdProgressEvent,
} from '../shared/bird-companion'
import type { SessionEvent } from '@craft-agent/shared/protocol'
import type { NativeAuthorityEvent } from './native-window-authority'

const WIDTH = 340
const HEIGHT = 360
const RESULT_DURATION_MS = 10_000
const ACTIVITIES = new Set(['computer', 'status', 'windows', 'snapshot', 'focus', 'screenshot', 'position', 'move', 'click', 'drag', 'scroll', 'type', 'key', 'wait', 'help', 'browser', 'search', 'editing', 'reading', 'shell', 'working'])

function validateProgress(value: unknown): BirdProgressEvent {
  if (!value || typeof value !== 'object') throw new Error('Invalid companion progress')
  const event = value as BirdProgressEvent
  if (typeof event.sessionId !== 'string' || !event.sessionId || event.sessionId.length > 512) throw new Error('Invalid session')
  const validId = (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 512
  switch (event.type) {
    case 'start': if (validId(event.startId)) return event; break
    case 'delete': return event
    case 'tool': if (validId(event.toolUseId) && ACTIVITIES.has(event.activity) && typeof event.computer === 'boolean') return event; break
    case 'result': if (validId(event.toolUseId) && typeof event.isError === 'boolean') return event; break
    case 'permission': if (validId(event.requestId) && typeof event.computer === 'boolean') return event; break
    case 'permission_resolved': if (validId(event.requestId) && typeof event.allowed === 'boolean') return event; break
    case 'finish': if (['complete', 'error', 'interrupted'].includes(event.outcome)) return event; break
  }
  throw new Error('Invalid companion progress')
}

export class BirdCompanionManager {
  private progress = new BirdCompanionProgress()
  private window: BrowserWindow | null = null
  private ready = false
  private disposed = false
  private resultTimer: ReturnType<typeof setTimeout> | null = null
  private lastPosition: { x: number; y: number } | null = null

  constructor(assertAppSender: (event: NativeAuthorityEvent) => { workspaceId: string }) {
    const saved = loadPreferences().birdCompanion
    this.progress.setPreferences({
      alwaysVisible: saved?.alwaysVisible === true,
      autoShowComputerUse: saved?.autoShowComputerUse !== false,
    })
    ipcMain.handle(IPC.getPreferences, event => { assertAppSender(event); return this.progress.preferences })
    ipcMain.handle(IPC.setPreferences, (event, updates: Partial<BirdCompanionPreferences>) => {
      assertAppSender(event)
      if (!updates || typeof updates !== 'object' || Object.keys(updates).some(key => !['alwaysVisible', 'autoShowComputerUse'].includes(key))
        || Object.values(updates).some(value => typeof value !== 'boolean')) throw new Error('Invalid companion settings')
      const preferences = { ...this.progress.preferences, ...updates }
      updatePreferences({ birdCompanion: preferences })
      this.progress.clearFinished()
      this.progress.setPreferences(preferences)
      this.render()
      return preferences
    })
    ipcMain.handle(IPC.observe, (event, progress: unknown) => {
      const { workspaceId } = assertAppSender(event)
      if (workspaceId) this.observeProgress(workspaceId, validateProgress(progress))
    })
    ipcMain.handle(IPC.ready, event => { this.assertCompanionSender(event); this.ready = true; this.render() })
    ipcMain.handle(IPC.getState, event => {
      this.assertCompanionSender(event)
      return { ...this.progress.getState(), language: i18n.language }
    })
    ipcMain.handle(IPC.dismiss, event => { this.assertCompanionSender(event); this.progress.dismiss(); this.render() })
    ipcMain.handle(IPC.interactive, (event, interactive: boolean) => {
      this.assertCompanionSender(event)
      if (typeof interactive !== 'boolean') return
      this.window?.setIgnoreMouseEvents(!interactive, { forward: true })
    })
    ipcMain.handle(IPC.move, (event, delta: { x: number; y: number }) => {
      this.assertCompanionSender(event)
      if (!delta || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return
      const window = this.window!
      const bounds = window.getBounds()
      const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
      const x = Math.round(Math.max(workArea.x, Math.min(workArea.x + workArea.width - WIDTH, bounds.x + Math.max(-500, Math.min(500, delta.x)))))
      const y = Math.round(Math.max(workArea.y, Math.min(workArea.y + workArea.height - HEIGHT, bounds.y + Math.max(-500, Math.min(500, delta.y)))))
      window.setPosition(x, y)
      this.lastPosition = { x, y }
    })
    i18n.on('languageChanged', this.languageChanged)
    screen.on('display-removed', this.displayChanged)
    screen.on('display-metrics-changed', this.displayChanged)
    this.render()
  }

  private languageChanged = () => this.render()
  private displayChanged = () => {
    if (!this.window || this.window.isDestroyed()) return
    const bounds = this.window.getBounds()
    const area = screen.getDisplayMatching(bounds).workArea
    this.window.setPosition(
      Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - WIDTH))),
      Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - HEIGHT))),
    )
    this.lastPosition = this.window.getBounds()
  }

  private assertCompanionSender(event: IpcMainInvokeEvent): void {
    if (!this.window || this.window.isDestroyed() || event.sender !== this.window.webContents
      || event.senderFrame !== event.sender.mainFrame) throw new Error('Requires the companion window')
  }

  observeSessionEvent(event: SessionEvent, workspaceId: string): void {
    const progress = toBirdProgressEvent(event)
    if (progress) this.observeProgress(workspaceId, progress)
  }

  private observeProgress(workspaceId: string, event: BirdProgressEvent): void {
    if (this.disposed || !this.progress.observe(workspaceId, event)) return
    this.render()
  }

  private createWindow(): void {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const window = new BrowserWindow({
      width: WIDTH, height: HEIGHT,
      ...(this.lastPosition ?? { x: area.x + area.width - WIDTH - 16, y: area.y + area.height - HEIGHT - 16 }),
      title: 'TokenBird Companion', transparent: true, backgroundColor: '#00000000',
      frame: false, show: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
      resizable: false, maximizable: false, minimizable: false, hasShadow: false,
      webPreferences: {
        preload: join(__dirname, 'bird-companion-preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    })
    this.window = window
    this.ready = false
    window.setIgnoreMouseEvents(true, { forward: true })
    // Electron excludes this window from Windows capture so it cannot cover the
    // agent's screenshot. This OS facility has platform-dependent support.
    window.setContentProtection(true)
    window.setAlwaysOnTop(true, 'floating')
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.on('closed', () => { if (this.window === window) { this.window = null; this.ready = false } })
    const loading = process.env.VITE_DEV_SERVER_URL
      ? window.loadURL(`${process.env.VITE_DEV_SERVER_URL.replace(/\/$/, '')}/bird-companion.html`)
      : window.loadFile(join(__dirname, 'renderer/bird-companion.html'))
    void loading.catch(error => {
      mainLog.error('[bird-companion] Failed to load:', error)
      if (!window.isDestroyed()) window.destroy()
    })
  }

  private render(): void {
    if (this.disposed) return
    const state = { ...this.progress.getState(), language: i18n.language }
    if (!state.visible) {
      if (this.resultTimer) clearTimeout(this.resultTimer)
      this.resultTimer = null
      // Destroy when hidden: no idle renderer/animation cost by default.
      if (this.window && !this.window.isDestroyed()) this.window.destroy()
      return
    }
    if (!this.window || this.window.isDestroyed()) this.createWindow()
    if (this.ready && this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC.state, state)
      if (!this.window.isVisible()) this.window.showInactive()
    }
    if (state.activeSessions === 0 && state.mood !== 'idle') {
      if (!this.resultTimer) this.resultTimer = setTimeout(() => {
        this.resultTimer = null
        this.progress.clearFinished()
        this.render()
      }, RESULT_DURATION_MS)
    } else if (this.resultTimer) {
      clearTimeout(this.resultTimer)
      this.resultTimer = null
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.resultTimer) clearTimeout(this.resultTimer)
    i18n.off('languageChanged', this.languageChanged)
    screen.off('display-removed', this.displayChanged)
    screen.off('display-metrics-changed', this.displayChanged)
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    for (const channel of Object.values(IPC)) if (channel !== IPC.state) ipcMain.removeHandler(channel)
  }
}

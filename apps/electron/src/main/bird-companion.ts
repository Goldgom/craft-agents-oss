import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { loadPreferences, updatePreferences } from '@craft-agent/shared/config/preferences'
import { i18n } from '@craft-agent/shared/i18n'
import { mainLog } from './logger'
import { BirdCompanionProgress } from './bird-companion-progress'
import { BIRD_WIDTH, BIRD_HEIGHT, BUBBLE_HEIGHT, defaultBirdBounds, bubbleBounds } from './bird-companion-layout'
import {
  BIRD_COMPANION_IPC as IPC,
  toBirdProgressEvent, type BirdCompanionPreferences, type BirdProgressEvent, type BirdWindowRole,
} from '../shared/bird-companion'
import type { SessionEvent } from '@craft-agent/shared/protocol'
import type { NativeAuthorityEvent } from './native-window-authority'

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
  private bubbleWindow: BrowserWindow | null = null
  private ready = false
  private bubbleReady = false
  private bubbleHeight = BUBBLE_HEIGHT
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
    ipcMain.handle(IPC.ready, event => {
      const window = this.assertCompanionSender(event)
      if (window === this.window) this.ready = true
      else this.bubbleReady = true
      this.render()
    })
    ipcMain.handle(IPC.getState, event => {
      this.assertCompanionSender(event)
      return { ...this.progress.getState(), language: i18n.language }
    })
    ipcMain.handle(IPC.dismissBubble, event => { this.assertCompanionSender(event, 'bubble'); this.progress.dismissBubble(); this.render() })
    ipcMain.handle(IPC.showBubble, event => { this.assertCompanionSender(event, 'bird'); this.progress.showBubble(); this.render() })
    ipcMain.handle(IPC.resizeBubble, (event, height: number) => {
      this.assertCompanionSender(event, 'bubble')
      if (!Number.isFinite(height)) return
      const nextHeight = Math.round(Math.max(100, Math.min(260, height)))
      if (this.bubbleHeight === nextHeight) return
      this.bubbleHeight = nextHeight
      this.positionBubble()
    })
    ipcMain.handle(IPC.interactive, (event, interactive: boolean) => {
      const window = this.assertCompanionSender(event)
      if (typeof interactive !== 'boolean') return
      window.setIgnoreMouseEvents(!interactive, { forward: true })
    })
    ipcMain.handle(IPC.move, (event, delta: { x: number; y: number }) => {
      const window = this.assertCompanionSender(event, 'bird')
      if (!delta || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return
      const bounds = window.getBounds()
      const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
      const x = Math.round(Math.max(workArea.x, Math.min(workArea.x + workArea.width - bounds.width, bounds.x + Math.max(-500, Math.min(500, delta.x)))))
      const y = Math.round(Math.max(workArea.y, Math.min(workArea.y + workArea.height - bounds.height, bounds.y + Math.max(-500, Math.min(500, delta.y)))))
      // Windows rounds the outer bounds outwards at fractional DPI. Feeding
      // those bounds back through setPosition accumulates growth. Always use
      // the intended content size, including on the first move.
      window.setContentBounds({ x, y, width: BIRD_WIDTH, height: BIRD_HEIGHT })
      const position = window.getBounds()
      this.lastPosition = { x: position.x, y: position.y }
      this.positionBubble()
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
    this.window.setContentBounds({
      x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width))),
      y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height))),
      width: BIRD_WIDTH, height: BIRD_HEIGHT,
    })
    const position = this.window.getBounds()
    this.lastPosition = { x: position.x, y: position.y }
    this.positionBubble()
  }

  private assertCompanionSender(event: IpcMainInvokeEvent, role?: BirdWindowRole): BrowserWindow {
    const candidates = role === 'bird' ? [this.window] : role === 'bubble' ? [this.bubbleWindow] : [this.window, this.bubbleWindow]
    const window = candidates.find(candidate => candidate && !candidate.isDestroyed() && candidate.webContents === event.sender)
    if (!window || event.senderFrame !== event.sender.mainFrame) throw new Error('Requires the companion window')
    return window
  }

  private positionBubble(): void {
    if (!this.window || this.window.isDestroyed() || !this.bubbleWindow || this.bubbleWindow.isDestroyed()) return
    const bird = this.window.getBounds()
    const area = screen.getDisplayMatching(bird).workArea
    const bounds = bubbleBounds(bird, area, this.bubbleHeight)
    this.bubbleWindow.setContentBounds(bounds)
  }

  observeSessionEvent(event: SessionEvent, workspaceId: string): void {
    const progress = toBirdProgressEvent(event)
    if (progress) this.observeProgress(workspaceId, progress)
  }

  private observeProgress(workspaceId: string, event: BirdProgressEvent): void {
    if (this.disposed || !this.progress.observe(workspaceId, event)) return
    this.render()
  }

  private createWindow(role: BirdWindowRole): void {
    const area = this.lastPosition
      ? screen.getDisplayNearestPoint(this.lastPosition).workArea
      : screen.getPrimaryDisplay().workArea
    const bird = { ...defaultBirdBounds(area), ...this.lastPosition }
    bird.x = Math.max(area.x, Math.min(bird.x, area.x + area.width - BIRD_WIDTH))
    bird.y = Math.max(area.y, Math.min(bird.y, area.y + area.height - BIRD_HEIGHT))
    const bounds = role === 'bird' ? bird : bubbleBounds(this.window?.getBounds() ?? bird, area, this.bubbleHeight)
    const window = new BrowserWindow({
      ...bounds,
      title: 'TokenBird Companion', transparent: true, backgroundColor: '#00000000',
      frame: false, show: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
      resizable: false, maximizable: false, minimizable: false, hasShadow: false,
      webPreferences: {
        preload: join(__dirname, 'bird-companion-preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        additionalArguments: [`--bird-companion-role=${role}`],
      },
    })
    if (role === 'bird') { this.window = window; this.ready = false }
    else { this.bubbleWindow = window; this.bubbleReady = false }
    window.setIgnoreMouseEvents(true, { forward: true })
    // Electron excludes this window from Windows capture so it cannot cover the
    // agent's screenshot. This OS facility has platform-dependent support.
    window.setContentProtection(true)
    window.setAlwaysOnTop(true, 'floating')
    // A non-resizable frameless window can start a few DIP larger on Windows.
    // Normalize before loading so dragging never changes the initial viewport.
    window.setContentBounds(bounds)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.on('close', event => {
      if (role === 'bubble' && !this.disposed) {
        event.preventDefault()
        this.progress.dismissBubble()
        this.render()
      }
    })
    window.on('closed', () => {
      if (this.window === window) { this.window = null; this.ready = false }
      if (this.bubbleWindow === window) { this.bubbleWindow = null; this.bubbleReady = false }
    })
    const loading = process.env.VITE_DEV_SERVER_URL
      ? window.loadURL(`${process.env.VITE_DEV_SERVER_URL.replace(/\/$/, '')}/bird-companion.html?role=${role}`)
      : window.loadFile(join(__dirname, 'renderer/bird-companion.html'), { query: { role } })
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
      if (this.bubbleWindow && !this.bubbleWindow.isDestroyed()) this.bubbleWindow.destroy()
      return
    }
    if (!this.window || this.window.isDestroyed()) this.createWindow('bird')
    if (this.ready && this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC.state, state)
      if (!this.window.isVisible()) this.window.showInactive()
    }
    if (state.bubbleVisible) {
      if (!this.bubbleWindow || this.bubbleWindow.isDestroyed()) this.createWindow('bubble')
      if (this.bubbleReady && this.bubbleWindow && !this.bubbleWindow.isDestroyed()) {
        this.bubbleWindow.webContents.send(IPC.state, state)
        this.positionBubble()
        if (!this.bubbleWindow.isVisible()) this.bubbleWindow.showInactive()
      }
    } else if (this.bubbleWindow && !this.bubbleWindow.isDestroyed()) this.bubbleWindow.destroy()
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
    if (this.bubbleWindow && !this.bubbleWindow.isDestroyed()) this.bubbleWindow.destroy()
    for (const channel of Object.values(IPC)) if (channel !== IPC.state) ipcMain.removeHandler(channel)
  }
}

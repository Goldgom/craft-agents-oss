import { afterEach, describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import { i18n, setupI18n } from '@craft-agent/shared/i18n'

const existsSync = fs.existsSync
mock.module('node:fs', () => ({
  ...fs,
  existsSync: (path: fs.PathLike) => /icon\.(ico|png)$/.test(String(path)) || existsSync(path),
}))

let focusedWindow: MockWindow | null = null
let lastTray: MockTray | null = null
let failTray = false
let nextId = 1
const quit = mock(() => {})

class MockWindow extends EventEmitter {
  readonly webContents = Object.assign(new EventEmitter(), {
    id: nextId++, mainFrame: {}, isDestroyed: (): boolean => false,
    setWindowOpenHandler: () => {}, send: mock((..._args: unknown[]) => {}), getURL: () => '',
  })
  destroyed = false
  visible = true
  minimized = false
  constructor(_options: unknown) { super() }
  isDestroyed() { return this.destroyed }
  isMinimized() { return this.minimized }
  restore() { this.minimized = false }
  show() { this.visible = true }
  hide() { this.visible = false }
  focus() { focusedWindow = this; this.emit('focus') }
  setTitle() {}
  loadFile() { return Promise.resolve() }
  close() {
    let prevented = false
    this.emit('close', { preventDefault: () => { prevented = true } })
    if (!prevented) this.destroy()
  }
  destroy() { this.destroyed = true; this.emit('closed') }
  static getFocusedWindow() { return focusedWindow }
}

class MockTray extends EventEmitter {
  destroyed = false
  tooltip = ''
  menu: Array<{ label?: string; click?: () => void }> = []
  constructor(_image: unknown) {
    super()
    if (failTray) throw new Error('Tray unavailable')
    lastTray = this
  }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true }
  setToolTip(value: string) { this.tooltip = value }
  setContextMenu(value: typeof this.menu) { this.menu = value }
}

mock.module('electron', () => ({
  BrowserWindow: MockWindow,
  Tray: MockTray,
  app: { isPackaged: true, getName: () => 'TokenBird', quit },
  shell: { openExternal: mock(() => Promise.resolve()) },
  nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
  Menu: { buildFromTemplate: (template: unknown) => template },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false, resize() { return this } }) },
}))
mock.module('../logger', () => ({
  mainLog: { info() {}, warn() {}, error() {} },
  windowLog: { info() {}, warn() {}, error() {} },
}))
const { WindowManager } = await import('../window-manager')
const { SystemTray } = await import('../system-tray')
setupI18n()

const managers: InstanceType<typeof WindowManager>[] = []
const trays: InstanceType<typeof SystemTray>[] = []
function makeWindow(focused = false) {
  const manager = new WindowManager()
  managers.push(manager)
  manager.setCloseToTrayEnabled(true)
  const window = manager.createWindow({ workspaceId: '', focused }) as unknown as MockWindow
  return { manager, window }
}
afterEach(async () => {
  for (const tray of trays.splice(0)) tray.destroy()
  for (const manager of managers.splice(0)) {
    manager.setAppQuitting(true)
    for (const { window } of manager.getAllWindows()) window.destroy()
  }
  focusedWindow = null
  lastTray = null
  failTray = false
  quit.mockClear()
  await i18n.changeLanguage('en')
})

describe('close to tray', () => {
  it('hides a main window immediately without destroying its renderer or requesting a layered close', () => {
    const { manager, window } = makeWindow()
    window.close()
    expect(window.visible).toBe(false)
    expect(window.destroyed).toBe(false)
    expect(manager.hasWindows()).toBe(true)
    expect(window.webContents.send).not.toHaveBeenCalled()
  })

  it('hides even when the renderer is unavailable', () => {
    const { window } = makeWindow()
    window.webContents.isDestroyed = () => true
    window.close()
    expect(window.visible).toBe(false)
    expect(window.destroyed).toBe(false)
  })

  it('keeps Ctrl/Cmd+W layered dismissal and hides after renderer confirmation', () => {
    const { manager, window } = makeWindow()
    window.webContents.emit('before-input-event', {}, { type: 'keyDown', key: 'w', control: true, meta: true })
    window.close()
    expect(window.visible).toBe(true)
    expect(window.webContents.send.mock.calls[0]?.[1]).toEqual({ source: 'keyboard-shortcut' })
    manager.forceCloseWindow(window.webContents.id)
    expect(window.visible).toBe(false)
    expect(window.destroyed).toBe(false)
  })

  it('restores the last active main window and its minimized state', () => {
    const { manager, window } = makeWindow()
    const other = manager.createWindow({ workspaceId: '' }) as unknown as MockWindow
    other.focus()
    other.close()
    other.minimized = true
    window.visible = false
    expect(manager.showMainWindow()).toBe(true)
    expect(other.visible).toBe(true)
    expect(other.minimized).toBe(false)
    expect(focusedWindow).toBe(other)
    expect(window.visible).toBe(false)
  })

  it('actually destroys focused session windows', () => {
    const { manager, window } = makeWindow(true)
    manager.forceCloseWindow(window.webContents.id)
    expect(window.destroyed).toBe(true)
    expect(manager.showMainWindow()).toBe(false)
  })

  it('allows native close when quitting instead of hiding', () => {
    const { manager, window } = makeWindow()
    manager.setAppQuitting(true)
    window.close()
    expect(window.destroyed).toBe(true)
  })

  it('destroys confirmed closes when the tray is unavailable', () => {
    const { manager, window } = makeWindow()
    manager.setCloseToTrayEnabled(false)
    manager.forceCloseWindow(window.webContents.id)
    expect(window.destroyed).toBe(true)
  })

  it('shows a hidden workspace window for focusOrCreateWindow', () => {
    const { manager, window } = makeWindow()
    window.close()
    expect(manager.focusOrCreateWindow('')).toBe(window as any)
    expect(window.visible).toBe(true)
  })
})

describe('native tray lifecycle', () => {
  it('opens on click and double-click and provides an explicit quit action', () => {
    const showWindow = mock(() => {})
    const tray = new SystemTray(showWindow)
    trays.push(tray)
    expect(tray.isAvailable).toBe(true)
    expect(lastTray?.tooltip).toBe('TokenBird')
    lastTray!.emit('click')
    lastTray!.emit('double-click')
    lastTray!.menu[0]!.click!()
    expect(showWindow).toHaveBeenCalledTimes(3)
    lastTray!.menu[2]!.click!()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('refreshes translated menu labels and removes its listener when destroyed', async () => {
    const tray = new SystemTray(() => {})
    trays.push(tray)
    await i18n.changeLanguage('zh-Hans')
    expect(lastTray!.menu[0]!.label).toBe('显示主窗口')
    tray.destroy()
    expect(tray.isAvailable).toBe(false)
    expect(lastTray!.destroyed).toBe(true)
  })

  it('reports tray initialization failures so close-to-tray stays disabled', () => {
    failTray = true
    const tray = new SystemTray(() => {})
    trays.push(tray)
    expect(tray.isAvailable).toBe(false)
  })
})

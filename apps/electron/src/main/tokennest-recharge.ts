import { BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { validateTokenNestRechargeUrl } from '@craft-agent/shared/utils/billing'

const windows = new Map<string, { window: BrowserWindow; closed: Promise<void> }>()

function isHttps(url: string): boolean {
  try { return new URL(url).protocol === 'https:' } catch { return false }
}

/** Website content has its own cookie store and never receives the app's preload or OAuth tokens. */
export function openTokenNestRechargeWindow(parent: BrowserWindow, requestedUrl: string, connectionSlug = 'default'): Promise<void> {
  const url = validateTokenNestRechargeUrl(requestedUrl)
  const accountKey = createHash('sha256').update(connectionSlug).digest('hex').slice(0, 16)
  const windowKey = `${parent.id}:${accountKey}`
  const existing = windows.get(windowKey)
  if (existing && !existing.window.isDestroyed()) {
    if (existing.window.isMinimized()) existing.window.restore()
    existing.window.focus()
    return existing.closed
  }
  const window = new BrowserWindow({
    parent,
    title: 'TokenNest',
    width: 1000,
    height: 760,
    minWidth: 600,
    minHeight: 480,
    autoHideMenuBar: true,
    webPreferences: {
      partition: `persist:tokennest-recharge-${accountKey}`,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  const children = new Set<BrowserWindow>()
  const secureContents = (target: BrowserWindow) => {
    target.webContents.on('will-navigate', (event, url) => { if (!isHttps(url)) event.preventDefault() })
    target.webContents.on('will-redirect', (event, url) => { if (!isHttps(url)) event.preventDefault() })
    target.webContents.setWindowOpenHandler(({ url }) => isHttps(url) ? {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: window,
        autoHideMenuBar: true,
        webPreferences: { partition: `persist:tokennest-recharge-${accountKey}`, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, preload: '' },
      },
    } : { action: 'deny' })
    target.webContents.on('did-create-window', child => {
      children.add(child)
      child.once('closed', () => children.delete(child))
      secureContents(child)
    })
  }
  secureContents(window)
  const closed = new Promise<void>(resolve => {
    window.once('closed', () => {
      windows.delete(windowKey)
      for (const child of children) if (!child.isDestroyed()) child.close()
      resolve()
    })
  })
  windows.set(windowKey, { window, closed })
  // Failures are surfaced to the caller so the user can retry opening the page.
  return window.loadURL(url).then(() => closed).catch(() => {
    // Closing the popup while it loads is a normal cancellation.
    if (window.isDestroyed()) return
    window.destroy()
    // Electron load errors can include the URL's one-time ticket.
    throw new Error('Unable to load the TokenNest recharge page')
  })
}

import { app, Menu, nativeImage, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { i18n } from '@craft-agent/shared/i18n'
import { mainLog } from './logger'

/** Owns the native tray and keeps its callbacks alive until explicit quit. */
export class SystemTray {
  private tray: Tray | null = null

  constructor(private readonly showWindow: () => void) {
    try {
      const names = process.platform === 'win32' ? ['icon.ico', 'icon.png'] : ['icon.png']
      const iconPath = names.flatMap(name => [
        join(__dirname, 'resources', name),
        join(__dirname, '../resources', name),
      ]).find(path => existsSync(path))
      if (!iconPath) throw new Error('Tray icon not found')

      const image = nativeImage.createFromPath(iconPath)
      if (image.isEmpty()) throw new Error('Tray icon could not be loaded')
      this.tray = new Tray(process.platform === 'darwin' ? image.resize({ width: 18, height: 18 }) : image)
      this.tray.on('click', this.showWindow)
      this.tray.on('double-click', this.showWindow)
      this.refresh()
      i18n.on('languageChanged', this.refresh)
    } catch (error) {
      this.destroy()
      mainLog.warn('Failed to create system tray; windows will close normally:', error)
    }
  }

  get isAvailable(): boolean {
    return this.tray !== null && !this.tray.isDestroyed()
  }

  readonly refresh = (): void => {
    if (!this.isAvailable) return
    this.tray!.setToolTip(app.getName())
    this.tray!.setContextMenu(Menu.buildFromTemplate([
      { label: i18n.t('menu.showMainWindow'), click: this.showWindow },
      { type: 'separator' },
      { label: i18n.t('menu.quitCraftAgents'), click: () => app.quit() },
    ]))
  }

  destroy(): void {
    i18n.off('languageChanged', this.refresh)
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy()
    this.tray = null
  }
}

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'

const updater = Object.assign(new EventEmitter(), {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  setFeedURL: mock((_feed: unknown) => {}),
  checkForUpdates: mock(async () => null),
})
const releaseUrl = 'https://gitcode.com/Goldgom/token-bird/releases/tag/26.10.20'
let releaseResult = { version: '26.10.20', available: true, releaseUrl, feedUrl: null as string | null }
let checkError: Error | undefined
let dismissed: string | null = null
const broadcasts: unknown[] = []
mock.module('electron-updater', () => ({ autoUpdater: updater }))
mock.module('electron', () => ({
  app: { isPackaged: true, getName: () => 'TokenBird-update-test', getPath: () => tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
}))
mock.module('os', () => ({ platform: () => 'win32' }))
mock.module('../logger', () => ({
  mainLog: { info() {}, warn() {}, error() {} },
  autoUpdateLog: { info() {}, error() {} },
}))
mock.module('@tokenbird/shared/version', () => ({ getAppVersion: () => '26.10.13' }))
mock.module('@tokenbird/shared/config', () => ({
  getDismissedUpdateVersion: () => dismissed,
  clearDismissedUpdateVersion: () => {},
}))
mock.module('@tokenbird/shared/utils/files', () => ({ readJsonFileSync: () => null }))
mock.module('../../shared/types', () => ({
  RPC_CHANNELS: { update: { AVAILABLE: 'update:available', DOWNLOAD_PROGRESS: 'update:progress' } },
}))
mock.module('../gitcode-release', () => ({
  getGitCodeUpdateFeed: async () => {
    if (checkError) throw checkError
    return releaseResult
  },
}))
const { checkForUpdates, checkForUpdatesOnLaunch, setAutoUpdateEventSink } = await import('../auto-update')
setAutoUpdateEventSink((_channel, _target, payload) => { broadcasts.push(payload) })

beforeEach(() => {
  checkError = undefined
  dismissed = null
  releaseResult = { version: '26.10.20', available: true, releaseUrl, feedUrl: null }
  updater.setFeedURL.mockClear()
  updater.checkForUpdates.mockClear()
  broadcasts.length = 0
})

describe('Windows GitCode update check', () => {
  test('announces a tag-only update without calling electron-updater', async () => {
    const info = await checkForUpdates()
    expect(info).toMatchObject({ available: true, latestVersion: '26.10.20', releaseUrl, downloadState: 'idle' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(broadcasts.at(-1)).toEqual(info)
    expect(await checkForUpdatesOnLaunch()).toEqual({ action: 'available', version: '26.10.20' })
  })

  test('respects dismissal while keeping the manual download available in settings', async () => {
    dismissed = '26.10.20'
    expect(await checkForUpdatesOnLaunch()).toEqual({ action: 'skipped', reason: 'dismissed', version: '26.10.20' })
    expect((await checkForUpdates()).releaseUrl).toBe(releaseUrl)
  })

  test('clears previous failures and manual download state when already up to date', async () => {
    checkError = new Error('Network unavailable')
    expect((await checkForUpdates()).downloadState).toBe('error')
    checkError = undefined
    releaseResult = { ...releaseResult, version: '26.10.13', available: false }
    expect(await checkForUpdates()).toMatchObject({ available: false, downloadState: 'idle', error: undefined, releaseUrl: undefined })
  })

  test('retains automatic updates for complete releases and restores download settings', async () => {
    releaseResult.feedUrl = 'https://gitcode.com/Goldgom/token-bird/releases/download/26.10.20/'
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', { version: '26.10.20' })
      return null
    })
    const info = await checkForUpdates({ autoDownload: false })
    expect(info).toMatchObject({ available: true, downloadState: 'idle', releaseUrl: undefined })
    expect(updater.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: releaseResult.feedUrl })
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updater.autoDownload).toBe(true)
  })
})

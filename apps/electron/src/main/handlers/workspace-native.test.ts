import { describe, expect, it } from 'bun:test'
import { createNativeWindowAuthority, type NativeAuthorityEvent } from '../native-window-authority'
import { NATIVE_SWITCH_WORKSPACE, registerNativeWorkspaceSwitch } from './workspace-native'

function fixture() {
  const frame = { url: 'file:///app/renderer/index.html?workspaceId=alpha', processId: 10, routingId: 20 }
  const sender = { id: 7, mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false }
  const window = { webContents: sender, isDestroyed: () => false }
  let workspaceId = 'alpha'
  const calls: string[] = []
  const registry = {
    getWindowByWebContentsId: (id: number) => id === 7 ? window : null,
    getWorkspaceForWindow: (id: number) => id === 7 ? workspaceId : null,
  }
  const assertSender = createNativeWindowAuthority(registry, ['file:///app/renderer/index.html'])
  let handler!: (event: NativeAuthorityEvent, input: unknown) => Promise<unknown>
  registerNativeWorkspaceSwitch({ handle: (name, fn) => { expect(name).toBe(NATIVE_SWITCH_WORKSPACE); handler = fn } }, {
    assertSender,
    getWorkspace: id => ['alpha', 'beta'].includes(id) ? { id, rootPath: `/tmp/${id}` } : undefined,
    updateWindowWorkspace: (id, target) => { if (id !== 7) return false; workspaceId = target; calls.push(`bind:${target}`); return true },
    getAllWindowsForWorkspace: () => [],
    clearActiveViewingSession: id => { calls.push(`clear:${id}`) },
    setupConfigWatcher: (_root, id) => { calls.push(`watch:${id}`) },
  })
  const event = { sender, senderFrame: frame }
  return { handler, event, sender, frame, window, assertSender, calls, workspace: () => workspaceId }
}

describe('native workspace authority', () => {
  it('changes only the actual registered window and invalidates old binding contexts', async () => {
    const f = fixture()
    const old = f.assertSender(f.event)
    expect(await f.handler(f.event, 'beta')).toEqual({ workspaceId: 'beta', remoteServer: null })
    expect(f.workspace()).toBe('beta')
    expect(f.assertSender(f.event).bindingId).not.toBe(old.bindingId)
    expect(f.calls).toEqual(['bind:beta', 'clear:alpha', 'watch:beta'])
  })

  it('rejects forged sender objects sharing a real id and iframe messages', async () => {
    const f = fixture()
    await expect(f.handler({ ...f.event, sender: { ...f.sender } }, 'beta')).rejects.toThrow('trusted application window')
    await expect(f.handler({ ...f.event, senderFrame: { ...f.frame } }, 'beta')).rejects.toThrow('trusted application window')
    await expect(f.handler({ ...f.event, senderFrame: null }, 'beta')).rejects.toThrow('trusted application window')
    expect(f.workspace()).toBe('alpha')
    expect(f.calls).toEqual([])
  })

  it('rejects non-app documents, sibling files, destroyed windows, and missing targets', async () => {
    const f = fixture()
    for (const url of ['https://untrusted.example/', 'file:///app/renderer/other.html', 'file:///app/renderer/index.html.evil']) {
      f.frame.url = url
      await expect(f.handler(f.event, 'beta')).rejects.toThrow('trusted application window')
    }
    f.frame.url = 'file:///app/renderer/index.html#settings'
    await expect(f.handler(f.event, 'missing')).rejects.toThrow('Workspace not found')
    await expect(f.handler(f.event, { workspaceId: 'beta' })).rejects.toThrow('Invalid workspace')
    f.window.isDestroyed = () => true
    await expect(f.handler(f.event, 'beta')).rejects.toThrow('trusted application window')
    expect(f.calls).toEqual([])
  })

  it('development trust is exact origin and path, never an origin-wide grant', () => {
    const f = fixture()
    const authority = createNativeWindowAuthority({ getWindowByWebContentsId: () => f.window, getWorkspaceForWindow: () => 'alpha' }, ['http://127.0.0.1:5173/'])
    f.frame.url = 'http://127.0.0.1:5173/?workspaceId=alpha'
    expect(authority(f.event).workspaceId).toBe('alpha')
    f.frame.url = 'http://127.0.0.1:5173/untrusted.html'
    expect(() => authority(f.event)).toThrow('trusted application window')
  })
})

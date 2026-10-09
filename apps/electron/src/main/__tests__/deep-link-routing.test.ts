import { describe, expect, it, mock } from 'bun:test'
import { handleDeepLink } from '../deep-link'
import { RPC_CHANNELS } from '../../shared/types'
import type { EventSink } from '@craft-agent/server-core/transport'
import type { WindowManager } from '../window-manager'

function createMockWindow(webContentsId: number) {
  return {
    isMinimized: () => false,
    restore: () => {},
    show: mock(() => {}),
    focus: () => {},
    isDestroyed: () => false,
    webContents: {
      id: webContentsId,
      isLoading: () => false,
      isDestroyed: () => false,
      once: () => {},
    },
  }
}

describe('handleDeepLink routing', () => {
  it('shows the retained window when a deep link has no workspace', async () => {
    const targetWindow = createMockWindow(19)
    const windowManager = {
      getFocusedWindow: () => null,
      getLastActiveWindow: () => targetWindow,
      getWorkspaceForWindow: () => 'ws-target',
    } as unknown as WindowManager

    const result = await handleDeepLink('tokenbird://settings/guides', windowManager)
    expect(result.success).toBe(true)
    expect(targetWindow.show).toHaveBeenCalledTimes(1)
  })

  it('prefers resolved target client over preferred caller client', async () => {
    const targetWindow = createMockWindow(22)

    const windowManager = {
      focusOrCreateWindow: () => targetWindow,
      getFocusedWindow: () => targetWindow,
      getLastActiveWindow: () => targetWindow,
      getWorkspaceForWindow: (webContentsId: number) => webContentsId === 22 ? 'ws-target' : 'ws-other',
    } as unknown as WindowManager

    const sent: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    const sink: EventSink = (channel, target, ...args) => {
      sent.push({ channel, target, args })
    }

    await handleDeepLink(
      'tokenbird://workspace/ws-target/allSessions',
      windowManager,
      sink,
      (wcId) => wcId === 22 ? 'client-target' : undefined,
      'client-caller',
    )

    expect(sent.length).toBe(1)
    expect(sent[0]?.channel).toBe(RPC_CHANNELS.deeplink.NAVIGATE)
    expect(sent[0]?.target).toEqual({ to: 'client', clientId: 'client-target' })
  })

  it('uses preferred client only when no resolver is provided', async () => {
    const targetWindow = createMockWindow(31)

    const windowManager = {
      focusOrCreateWindow: () => targetWindow,
      getFocusedWindow: () => targetWindow,
      getLastActiveWindow: () => targetWindow,
      getWorkspaceForWindow: () => 'ws-target',
    } as unknown as WindowManager

    const sent: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    const sink: EventSink = (channel, target, ...args) => {
      sent.push({ channel, target, args })
    }

    await handleDeepLink(
      'tokenbird://workspace/ws-target/allSessions',
      windowManager,
      sink,
      undefined,
      'client-caller',
    )

    expect(sent.length).toBe(1)
    expect(sent[0]?.target).toEqual({ to: 'client', clientId: 'client-caller' })
  })

  it('falls back to workspace routing when resolver exists but target client is unresolved', async () => {
    const targetWindow = createMockWindow(44)

    const windowManager = {
      focusOrCreateWindow: () => targetWindow,
      getFocusedWindow: () => targetWindow,
      getLastActiveWindow: () => targetWindow,
      getWorkspaceForWindow: () => 'ws-target',
    } as unknown as WindowManager

    const sent: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    const sink: EventSink = (channel, target, ...args) => {
      sent.push({ channel, target, args })
    }

    await handleDeepLink(
      'tokenbird://workspace/ws-target/allSessions',
      windowManager,
      sink,
      () => undefined,
      'client-caller',
    )

    expect(sent.length).toBe(1)
    expect(sent[0]?.target).toEqual({ to: 'workspace', workspaceId: 'ws-target' })
  })
})

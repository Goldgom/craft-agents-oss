import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { CLIENT_OPEN_EXTERNAL, CLIENT_OPEN_PATH, CLIENT_SHOW_IN_FOLDER } from '@craft-agent/server-core/transport'
import { homedir } from 'os'
import { join, sep } from 'path'
import type { RpcServer, HandlerFn, RequestContext } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerSystemCoreHandlers } from './system'

function createTestHarness(overrides?: { workspaceId?: string | null; openPathError?: string }) {
  const handlers = new Map<string, HandlerFn>()
  const invokeClientCalls: Array<{ clientId: string; channel: string; args: any[] }> = []
  const pushCalls: Array<{ channel: string; target: any; args: any[] }> = []

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push(channel, target, ...args) {
      pushCalls.push({ channel, target, args })
    },
    async invokeClient(clientId, channel, ...args) {
      invokeClientCalls.push({ clientId, channel, args })
      if (channel === CLIENT_OPEN_PATH && overrides?.openPathError) return { error: overrides.openPathError }
      return undefined
    },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }

  const deps: HandlerDeps = {
    sessionManager: {} as HandlerDeps['sessionManager'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
  }

  registerSystemCoreHandlers(server, deps)

  const openUrl = handlers.get(RPC_CHANNELS.shell.OPEN_URL)
  if (!openUrl) {
    throw new Error('OPEN_URL handler not registered')
  }

  const ctx: RequestContext = {
    clientId: 'client-1',
    workspaceId: overrides?.workspaceId ?? 'ws-1',
    webContentsId: 101,
  }

  return { openUrl, ctx, invokeClientCalls, pushCalls, handlers }
}

describe('user shell file actions', () => {
  const outside = sep === '\\' ? 'Z:\\outside\\report.docx' : '/outside/report.docx'

  it('opens files outside the workspace on the requesting client', async () => {
    const { handlers, ctx, invokeClientCalls } = createTestHarness()
    await handlers.get(RPC_CHANNELS.shell.OPEN_FILE)!(ctx, outside)
    expect(invokeClientCalls).toEqual([{ clientId: ctx.clientId, channel: CLIENT_OPEN_PATH, args: [outside] }])
  })

  it('reveals files outside the workspace on the requesting client', async () => {
    const { handlers, ctx, invokeClientCalls } = createTestHarness()
    await handlers.get(RPC_CHANNELS.shell.SHOW_IN_FOLDER)!(ctx, outside)
    expect(invokeClientCalls).toEqual([{ clientId: ctx.clientId, channel: CLIENT_SHOW_IN_FOLDER, args: [outside] }])
  })

  it('allows the user to open a sensitive file and expands the home shortcut', async () => {
    const { handlers, ctx, invokeClientCalls } = createTestHarness()
    await handlers.get(RPC_CHANNELS.shell.OPEN_FILE)!(ctx, '~/.ssh/id_rsa')
    expect(invokeClientCalls[0]!.args).toEqual([join(homedir(), '.ssh', 'id_rsa')])
  })

  it('keeps OS open failures visible', async () => {
    const { handlers, ctx } = createTestHarness({ openPathError: 'File does not exist' })
    await expect(handlers.get(RPC_CHANNELS.shell.OPEN_FILE)!(ctx, outside)).rejects.toThrow('Failed to open file: File does not exist')
  })

  it('rejects malformed paths before invoking the client', async () => {
    const { handlers, ctx, invokeClientCalls } = createTestHarness()
    for (const path of ['', ' ', 'bad\0path', null]) {
      await expect(handlers.get(RPC_CHANNELS.shell.OPEN_FILE)!(ctx, path)).rejects.toThrow('Invalid file path')
    }
    expect(invokeClientCalls).toHaveLength(0)
  })
})

describe('registerSystemCoreHandlers OPEN_URL', () => {
  it('routes craftagents action links internally via deeplink:navigate', async () => {
    const { openUrl, ctx, invokeClientCalls, pushCalls } = createTestHarness()

    await openUrl(ctx, 'tokenbird://action/new-session?input=sg&send=true')

    expect(invokeClientCalls).toHaveLength(0)
    expect(pushCalls).toHaveLength(1)
    expect(pushCalls[0]).toEqual({
      channel: RPC_CHANNELS.deeplink.NAVIGATE,
      target: { to: 'client', clientId: 'client-1' },
      args: [{ action: 'new-session', actionParams: { input: 'sg', send: 'true' } }],
    })
  })

  it('routes workspace deep links to workspace target when URL workspace differs', async () => {
    const { openUrl, ctx, invokeClientCalls, pushCalls } = createTestHarness({ workspaceId: 'ws-1' })

    await openUrl(ctx, 'tokenbird://workspace/ws-2/action/new-session?input=hello')

    expect(invokeClientCalls).toHaveLength(0)
    expect(pushCalls).toHaveLength(1)
    expect(pushCalls[0]).toEqual({
      channel: RPC_CHANNELS.deeplink.NAVIGATE,
      target: { to: 'workspace', workspaceId: 'ws-2' },
      args: [{ action: 'new-session', actionParams: { input: 'hello' } }],
    })
  })

  it('falls back to client openExternal for craftagents window-mode links', async () => {
    const { openUrl, ctx, invokeClientCalls, pushCalls } = createTestHarness()

    await openUrl(ctx, 'tokenbird://action/new-session?window=focused')

    expect(pushCalls).toHaveLength(0)
    expect(invokeClientCalls).toHaveLength(1)
    expect(invokeClientCalls[0]).toEqual({
      clientId: 'client-1',
      channel: CLIENT_OPEN_EXTERNAL,
      args: ['tokenbird://action/new-session?window=focused'],
    })
  })

  it('keeps forwarding normal http URLs via client openExternal', async () => {
    const { openUrl, ctx, invokeClientCalls } = createTestHarness()

    await openUrl(ctx, 'https://example.com')

    expect(invokeClientCalls).toHaveLength(1)
    expect(invokeClientCalls[0]).toEqual({
      clientId: 'client-1',
      channel: CLIENT_OPEN_EXTERNAL,
      args: ['https://example.com'],
    })
  })

  it('rejects unsupported protocols with a per-scheme reason', async () => {
    const { openUrl, ctx } = createTestHarness()

    // OPEN_URL uses a blocklist (url-safety.ts) and rejects known-dangerous
    // schemes by name. file: is one of them — and the most important on
    // Windows where it's an RCE vector. The thrown error includes the
    // scheme in parens and a human-readable reason so the renderer can
    // show a useful toast instead of a generic "Invalid URL".
    await expect(openUrl(ctx, 'file:///tmp/test.txt')).rejects.toThrow(
      /^Failed to open URL: URL blocked \(file:\)\. file: URLs are blocked /,
    )
  })

  it('rejects javascript: URLs with the JavaScript-specific reason', async () => {
    const { openUrl, ctx } = createTestHarness()

    await expect(openUrl(ctx, 'javascript:alert(1)')).rejects.toThrow(
      /^Failed to open URL: URL blocked \(javascript:\)\. JavaScript URLs /,
    )
  })

  it('rejects malformed URLs through the shared classifier instead of raw URL parsing', async () => {
    const { openUrl, ctx } = createTestHarness()

    await expect(openUrl(ctx, 'not a url')).rejects.toThrow(
      /^Failed to open URL: URL blocked\. URL is malformed and cannot be parsed\./,
    )
  })
})

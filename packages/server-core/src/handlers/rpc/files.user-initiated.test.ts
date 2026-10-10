import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, writeFile, unlink, rmdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerFilesHandlers } from './files'

const handlers = new Map<string, HandlerFn>()
const ctx: RequestContext = { clientId: 'clicked-client', workspaceId: null, webContentsId: null }
registerFilesHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } } as RpcServer, {
  platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
} as unknown as HandlerDeps)
const invoke = (channel: string, path: string, options?: unknown) => handlers.get(channel)!(ctx, path, options)

let root: string
let file: string
const content = 'user-selected file contents'
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'user-file-click-'))
  file = join(root, 'credentials.json')
  await writeFile(file, content)
})
afterAll(async () => { await unlink(file); await rmdir(root) })

describe('user-initiated file previews and downloads', () => {
  it('reads actual file contents for a clicked text preview', async () => {
    expect(await invoke(RPC_CHANNELS.file.READ, file, { userInitiated: true })).toBe(content)
  })

  it('reads binary contents for a clicked PDF preview or download', async () => {
    expect(await invoke(RPC_CHANNELS.file.READ_BINARY, file, { userInitiated: true })).toEqual(new Uint8Array(Buffer.from(content)))
  })

  it('reads a data URL for a clicked image preview', async () => {
    expect(await invoke(RPC_CHANNELS.file.READ_DATA_URL, file, { userInitiated: true })).toBe(`data:application/octet-stream;base64,${Buffer.from(content).toString('base64')}`)
  })

  for (const channel of [RPC_CHANNELS.file.READ, RPC_CHANNELS.file.READ_BINARY, RPC_CHANNELS.file.READ_DATA_URL]) {
    it(`${channel} keeps sensitive files blocked for ordinary reads`, async () => {
      await expect(invoke(channel, file)).rejects.toThrow('cannot read sensitive files')
      await expect(invoke(channel, file, { userInitiated: false })).rejects.toThrow('cannot read sensitive files')
      await expect(invoke(channel, file, { userInitiated: 'true' })).rejects.toThrow('cannot read sensitive files')
    })

    it(`${channel} bypasses the directory policy only for explicit clicks and retains filesystem errors`, async () => {
      const outside = sep === '\\' ? 'Z:\\outside\\missing.txt' : '/outside/missing.txt'
      await expect(invoke(channel, outside)).rejects.toThrow('outside allowed directories')
      await expect(invoke(channel, outside, { userInitiated: true })).rejects.toThrow('ENOENT')
    })
  }

  it('keeps attachments and automatic thumbnails restricted', async () => {
    expect(await invoke(RPC_CHANNELS.file.READ_ATTACHMENT, file, { userInitiated: true })).toBeNull()
    await expect(invoke(RPC_CHANNELS.file.READ_PREVIEW_DATA_URL, file)).rejects.toThrow('cannot read sensitive files')
  })
})

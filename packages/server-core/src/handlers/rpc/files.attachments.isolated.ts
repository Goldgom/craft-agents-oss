import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { HandlerDeps } from '../handler-deps'
import type { HandlerFn, RpcServer } from '../../transport'

// Run separately: config paths are captured at module initialization.
const root = await mkdtemp(join(tmpdir(), 'tokenbird-attachment-test-'))
const previousConfig = process.env.TOKENBIRD_CONFIG_DIR
process.env.TOKENBIRD_CONFIG_DIR = root
await writeFile(join(root, 'config.json'), JSON.stringify({
  workspaces: [{ id: 'test-workspace', name: 'Test', rootPath: join(root, 'workspace') }],
  activeWorkspaceId: 'test-workspace',
}))
const { registerFilesHandlers } = await import('./files')
const { RPC_CHANNELS } = await import('@tokenbird/shared/protocol')
const handlers = new Map<string, HandlerFn>()
const warnings: unknown[][] = []
registerFilesHandlers({ handle: (channel: string, handler: HandlerFn) => { handlers.set(channel, handler) } } as unknown as RpcServer, {
  platform: { logger: { info() {}, warn(...args: unknown[]) { warnings.push(args) }, error() {}, debug() {} } },
  sessionManager: { getSession: async () => ({ workspaceId: 'test-workspace' }) },
} as unknown as HandlerDeps)

afterAll(async () => {
  if (previousConfig === undefined) delete process.env.TOKENBIRD_CONFIG_DIR
  else process.env.TOKENBIRD_CONFIG_DIR = previousConfig
  if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}tokenbird-attachment-test-`)) throw new Error('Invalid cleanup path')
  await rm(root, { recursive: true, force: true })
})

const bytes = Buffer.from('unsupported binary document content')
const store = (type: string, name: string, size = bytes.length) =>
  handlers.get(RPC_CHANNELS.file.STORE_ATTACHMENT)!({ clientId: 'test', workspaceId: null, webContentsId: null },
    'test-session', { type, name, size, mimeType: 'application/octet-stream', base64: bytes.toString('base64') })

test('legacy Office conversion failure preserves the file and returns a usable prompt path', async () => {
  const stored = await store('office', '实验4 数据表的CURD操作.doc')
  expect(stored.markdownPath).toBeUndefined()
  expect(stored.storedPath).toEndWith('_实验4 数据表的CURD操作.doc')
  expect(await readFile(stored.storedPath)).toEqual(bytes)
  expect(await readdir(dirname(stored.storedPath))).toEqual([stored.storedPath.split(sep).at(-1)!])
  expect(warnings.some(args => String(args[0]).includes('using stored file path'))).toBe(true)
}, 30_000)

test('unknown binary formats also retain a stored path', async () => {
  const stored = await store('unknown', 'archive.custom')
  expect(stored.markdownPath).toBeUndefined()
  expect(await readFile(stored.storedPath)).toEqual(bytes)
})

test('real upload corruption still rejects instead of sending a missing attachment', async () => {
  await expect(store('office', 'broken.doc', bytes.length + 200)).rejects.toThrow('size mismatch')
})

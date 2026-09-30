import { expect, test } from 'bun:test'
import { importMcpEntries, type McpImportActions } from './mcp-import-runner'
import type { McpImportEntry } from './mcp-import'

const entry: McpImportEntry = { name: 'Dummy', mcp: { transport: 'http', url: 'https://example.invalid', authType: 'bearer' }, credential: 'dummy-secret' }

test('credential failure rolls the created source back and is not counted as imported', async () => {
  const deleted: string[] = []
  const actions: McpImportActions = { create: async () => ({ slug: 'dummy' }), save: async () => { throw new Error('dummy-secret'); }, remove: async slug => { deleted.push(slug) } }
  const result = await importMcpEntries([entry], [], actions)
  expect(result).toEqual({ imported: 0, skipped: 0, failures: [{ name: 'Dummy', reason: 'credential' }] })
  expect(deleted).toEqual(['dummy'])
  expect(JSON.stringify(result)).not.toContain('dummy-secret')
})
test('rollback failure is explicit and duplicates are skipped instead of recreated', async () => {
  let creates = 0
  const result = await importMcpEntries([entry, entry], [], {
    create: async () => { creates++; return { slug: 'dummy' } }, save: async () => { throw new Error('dummy-failure') }, remove: async () => { throw new Error('dummy-failure') },
  })
  expect(result).toEqual({ imported: 0, skipped: 1, failures: [{ name: 'Dummy', reason: 'rollback' }] })
  expect(creates).toBe(1)
})
test('failed saves can be retried and successful duplicates are counted once', async () => {
  let saves = 0
  const result = await importMcpEntries([entry, entry, entry], [], {
    create: async () => ({ slug: 'dummy' }), save: async () => { if (++saves === 1) throw new Error('dummy-failure') }, remove: async () => {},
  })
  expect(result).toEqual({ imported: 1, skipped: 1, failures: [{ name: 'Dummy', reason: 'credential' }] })
})

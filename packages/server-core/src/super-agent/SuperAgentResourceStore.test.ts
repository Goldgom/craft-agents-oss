import { expect, test } from 'bun:test'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { CredentialManager } from '@tokenbird/shared/credentials'
import { SecureStorageBackend } from '@tokenbird/shared/credentials/backends/secure-storage'
import { loadWorkspaceSources, saveSourceConfig } from '@tokenbird/shared/sources'
import { superAgentResourceScope } from '@tokenbird/shared/super-agent/resource-scope'
import { SuperAgentResourceStore } from './SuperAgentResourceStore'
import { superAgentFixture, until } from './SuperAgentTestSupport'

const source = { id: 'shared-api', slug: 'shared-api', name: 'Shared API', type: 'api' as const, provider: 'custom', enabled: true, api: { baseUrl: 'https://example.com', authType: 'bearer' as const }, createdAt: 1, updatedAt: 1 }
async function fixture() {
  const f = await superAgentFixture()
  const root = join(f.root, 'normal')
  await mkdir(root)
  const manager = new CredentialManager()
  manager.configureBackend(new SecureStorageBackend(join(f.root, 'test-vault.enc')))
  return { ...f, rootPath: root, manager, store: new SuperAgentResourceStore(manager) }
}

test('all modes see the same source and credential data, including non-path workspace IDs', async () => {
  const f = await fixture()
  saveSourceConfig(f.rootPath, source)
  await f.manager.set({ type: 'saved_credential', workspaceId: 'workspace-id', name: 'account' }, { value: 'private-value' })
  expect(superAgentResourceScope(f.rootPath).rootPath).toBe(f.rootPath)
  const data = await f.store.snapshot('workspace-id', f.rootPath)
  expect(data.sources.map(item => item.config.slug)).toEqual(['shared-api'])
  expect(data.credentials).toHaveLength(1)
  expect(JSON.stringify(data)).not.toContain('private-value')
  await f.store.access('workspace-id', f.rootPath, 'save-sources', { configs: [{ ...source, name: 'Updated by Super Agent' }] })
  expect(loadWorkspaceSources(f.rootPath)[0]!.config.name).toBe('Updated by Super Agent')
  await f.store.access('workspace-id', f.rootPath, 'save-credentials', [{ op: 'upsert', id: { type: 'saved_credential', workspaceId: 'workspace-id', name: 'account' }, credential: { value: 'updated-secret' } }])
  expect((await f.manager.get({ type: 'saved_credential', workspaceId: 'workspace-id', name: 'account' }))?.value).toBe('updated-secret')
  await expect(f.store.access('workspace-id', f.rootPath, 'save-credentials', [{ op: 'delete', id: { type: 'saved_credential', workspaceId: 'foreign', name: 'account' } }])).rejects.toThrow('outside')
})

test('encrypted backup restores resources and credentials into another workspace without plaintext secrets', async () => {
  const f = await fixture()
  saveSourceConfig(f.rootPath, source)
  await f.manager.set({ type: 'saved_credential', workspaceId: 'normal-id', name: 'account' }, { value: 'private-account' })
  await f.manager.set({ type: 'source_bearer', workspaceId: basename(f.rootPath), sourceId: source.slug }, { value: 'private-source' })
  const backup = await f.store.access('normal-id', f.rootPath, 'export', { password: 'backup-password' }) as { encryptedExport: unknown }
  expect(JSON.stringify(backup)).not.toContain('private-account')
  expect(JSON.stringify(backup)).not.toContain('private-source')
  const target = join(f.root, 'target')
  await expect(f.store.access('target-id', target, 'import', { encrypted: backup.encryptedExport, password: 'wrong-password' })).rejects.toThrow('password')
  expect(loadWorkspaceSources(target)).toHaveLength(0)
  await f.store.access('target-id', target, 'import', { encrypted: backup.encryptedExport, password: 'backup-password' })
  expect(loadWorkspaceSources(target)[0]!.config.slug).toBe(source.slug)
  expect((await f.manager.get({ type: 'saved_credential', workspaceId: 'target-id', name: 'account' }))?.value).toBe('private-account')
  expect((await f.manager.get({ type: 'source_bearer', workspaceId: basename(target), sourceId: source.slug }))?.value).toBe('private-source')
  expect((await readFile(join(f.root, 'test-vault.enc'))).includes(Buffer.from('private-account'))).toBe(false)
})

test('invalid bundle leaves shared source configuration untouched', async () => {
  const f = await fixture()
  await expect(f.store.access('normal-id', f.rootPath, 'import', { version: 1, sources: [source], automations: { automations: { SchedulerTick: [{ cron: 3, actions: [] }] } } })).rejects.toThrow()
  expect(loadWorkspaceSources(f.rootPath)).toHaveLength(0)
  await f.store.access('normal-id', f.rootPath, 'import', { version: 1, sources: [source] })
  await f.store.access('normal-id', f.rootPath, 'import', { version: 1, sources: [source] })
  expect(loadWorkspaceSources(f.rootPath)).toHaveLength(1)
})

test('AI resource writes have deduplicated receipts and update the shared source catalog', async () => {
  const writes: unknown[] = []
  const f = await superAgentFixture({ accessResources: async (_workspace, operation, value) => { writes.push({ operation, value }); return { sources: [{ config: source }] } } })
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'task', nodeId: 'worker', title: 'Configure source', instructions: 'Create the requested API source' })
  const running = await until(() => f.service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
  const sessionId = running.state.tasks[0]!.sessionId!
  const args = { requestId: 'write-source', operation: 'save-sources', value: { configs: [source] } }
  const result = await f.service.callNodeActionTool('alpha', sessionId, 'super_agent_manage_resources', args)
  expect(result.receipt.applied[0]?.type).toBe('manage-resources')
  expect(await f.service.callNodeActionTool('alpha', sessionId, 'super_agent_manage_resources', args)).toEqual(result)
  expect(writes).toHaveLength(1)
  expect((await f.service.get('alpha')).config!.sourceSlugs).toEqual([source.slug])
  await expect(f.service.callNodeActionTool('alpha', 'foreign-session', 'super_agent_manage_resources', args)).rejects.toThrow()
})

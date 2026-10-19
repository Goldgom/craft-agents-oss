import { randomUUID, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { getCredentialManager, type CredentialManager, type CredentialId } from '@tokenbird/shared/credentials'
import { validateNativeCredentialChanges } from '@tokenbird/shared/credentials/native-validation'
import { loadWorkspaceSources, saveSourceConfig, deleteSource, markSourceAuthenticated, type FolderSourceConfig } from '@tokenbird/shared/sources'
import { validateSourceConfig } from '@tokenbird/shared/config/validators'
import { validateAutomationsConfig } from '@tokenbird/shared/automations/validation'
import { superAgentResourceScope } from '@tokenbird/shared/super-agent/resource-scope'
import { appendAutomationHistoryEntry, executeScriptAction, executeWebhookRequest, buildScriptEnv, type AutomationsConfig } from '@tokenbird/shared/automations'

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,199}$/)

async function readJson(path: string, fallback: unknown): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error }
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await open(temp, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
    await rename(temp, path)
  } finally { await unlink(temp).catch(() => undefined) }
}

/** Host-only resource operations. Returned snapshots never include credential material. */
export class SuperAgentResourceStore {
  private locks = new Map<string, Promise<unknown>>()
  constructor(private manager: CredentialManager = getCredentialManager(), private onPrompt?: (workspaceId: string, text: string, automationId: string, runId: string) => Promise<void>) {}

  async initialize(workspaceRoot: string) {
    const scope = superAgentResourceScope(workspaceRoot)
    await mkdir(scope.rootPath, { recursive: true })
    return scope
  }

  async access(workspaceId: string, workspaceRoot: string, operation: 'get' | 'export' | 'import' | 'save-sources' | 'save-automations' | 'save-credentials' | 'test-automation' | 'replay-automation', value?: unknown): Promise<unknown> {
    const previous = this.locks.get(workspaceRoot) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      const scope = await this.initialize(workspaceRoot)
      let encryptedExport: unknown
      if (operation === 'export') encryptedExport = await this.export(workspaceId, workspaceRoot, value)
      if (operation === 'import') await this.import(workspaceId, workspaceRoot, value)
      let executionResults: unknown[] | undefined
      if (operation === 'test-automation' || operation === 'replay-automation') executionResults = await this.runAutomation(workspaceId, scope.rootPath, value)
      if (operation === 'save-sources') {
        const request = z.object({ configs: z.array(z.unknown()).max(100), deletedSlugs: z.array(slugSchema).max(100).default([]) }).strict().parse(value)
        for (const config of request.configs) {
          const validation = validateSourceConfig(config)
          if (!validation.valid) throw new Error(validation.errors.map(issue => `${issue.path}: ${issue.message}`).join('\n'))
          slugSchema.parse((config as FolderSourceConfig).slug)
        }
        for (const config of request.configs) saveSourceConfig(scope.rootPath, config as FolderSourceConfig)
        for (const slug of request.deletedSlugs) deleteSource(scope.rootPath, slug)
      }
      if (operation === 'save-automations') {
        const validation = validateAutomationsConfig(value)
        if (!validation.valid || !validation.config) throw new Error(validation.errors.join('\n'))
        await atomicJson(join(scope.rootPath, 'automations.json'), validation.config)
      }
      if (operation === 'save-credentials') {
        const changes = validateNativeCredentialChanges(value)
        for (const change of changes) if (change.id.workspaceId !== (change.id.type === 'saved_credential' ? workspaceId : scope.credentialWorkspaceId) || !['saved_credential', 'source_apikey', 'source_bearer', 'source_basic', 'source_oauth'].includes(change.id.type)) throw new Error('Credential is outside the Super Agent resource scope')
        for (const change of changes) {
          if (change.id.sourceId && !loadWorkspaceSources(scope.rootPath).some(source => source.config.slug === change.id.sourceId)) throw new Error('Unknown scoped source')
          if (change.op === 'delete') await this.manager.delete(change.id)
          else {
            const stored = { ...await this.manager.get(change.id), value: '' } as import('@tokenbird/shared/credentials').StoredCredential
            const existing = await this.manager.get(change.id)
            if (existing) Object.assign(stored, existing)
            for (const [key, field] of Object.entries(change.credential)) {
              if (field === null) delete (stored as unknown as Record<string, unknown>)[key]
              else (stored as unknown as Record<string, unknown>)[key] = field
            }
            if (!stored.value) throw new Error('A non-empty credential secret is required')
            await this.manager.set(change.id, stored)
            if (change.id.sourceId) markSourceAuthenticated(scope.rootPath, change.id.sourceId)
          }
        }
      }
      return { ...await this.snapshot(workspaceId, workspaceRoot), executionResults, encryptedExport }
    })
    this.locks.set(workspaceRoot, next)
    try { return await next } finally { if (this.locks.get(workspaceRoot) === next) this.locks.delete(workspaceRoot) }
  }

  async snapshot(workspaceId: string, workspaceRoot: string) {
    const scope = await this.initialize(workspaceRoot)
    const metadata = async (id: CredentialId) => {
      const value = await this.manager.get(id)
      return { id, username: value?.username, kind: value?.credentialKind, url: value?.credentialUrl, hasSecret: !!value?.value }
    }
    const [credentials, importCredentials] = await Promise.all([
      Promise.all((await this.manager.list()).filter(id => id.type === 'saved_credential' ? id.workspaceId === workspaceId : id.type.startsWith('source_') && id.workspaceId === scope.credentialWorkspaceId).map(metadata)),
      Promise.all((await this.manager.list({ workspaceId, type: 'saved_credential' })).map(metadata)),
    ])
    return { credentialWorkspaceId: scope.credentialWorkspaceId, savedCredentialWorkspaceId: workspaceId, sources: loadWorkspaceSources(scope.rootPath), credentials,
      automations: await readJson(join(scope.rootPath, 'automations.json'), { automations: {} }) as AutomationsConfig,
      history: (await readFile(join(scope.rootPath, 'automations-history.jsonl'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error })).trim().split('\n').filter(Boolean).slice(-100).map(line => JSON.parse(line)),
      imports: await readJson(join(scope.rootPath, 'imports.json'), []),
      availableImports: { sources: loadWorkspaceSources(workspaceRoot).map(source => ({ slug: source.config.slug, name: source.config.name })), credentials: importCredentials,
        automations: await readJson(join(workspaceRoot, 'automations.json'), { automations: {} }) as AutomationsConfig } }
  }

  private async runAutomation(workspaceId: string, rootPath: string, value: unknown): Promise<unknown[]> {
    const { id } = z.object({ id: z.string().min(1).max(200) }).strict().parse(value)
    const config = await readJson(join(rootPath, 'automations.json'), { automations: {} }) as AutomationsConfig
    const matcher = Object.values(config.automations).flat().find(matcher => matcher.id === id)
    if (!matcher) throw new Error('Automation no longer exists')
    const results: unknown[] = []
    for (const action of matcher.actions) {
      const started = Date.now()
      let ok = true, result: unknown
      try {
        if (action.type === 'prompt') {
          if (!this.onPrompt) throw new Error('Automation prompt execution is unavailable')
          await this.onPrompt(workspaceId, action.prompt, id, randomUUID())
          result = { queued: true, type: 'prompt' }
        } else if (action.type === 'webhook') {
          const response = await executeWebhookRequest(action)
          ok = response.success; result = response
        } else {
          const response = await executeScriptAction({ ...action, timeoutMs: Math.min(action.timeoutMs ?? 25000, 25000) },
            { workspaceRootPath: rootPath, env: buildScriptEnv('SchedulerTick', { workspaceId, timestamp: started }, { workspaceRootPath: rootPath }) })
          ok = response.success; result = response
        }
      } catch (error) { ok = false; result = { error: error instanceof Error ? error.message : String(error) } }
      results.push({ ok, type: action.type, result, durationMs: Date.now() - started })
      await appendAutomationHistoryEntry(rootPath, { id, ts: started, ok, ...(action.type === 'prompt' ? { prompt: action.prompt } : {}), ...(!ok ? { error: JSON.stringify(result) } : {}) })
    }
    return results
  }

  private async export(workspaceId: string, workspaceRoot: string, value: unknown) {
    const { password } = z.object({ password: z.string().min(8).max(1024) }).strict().parse(value)
    const scope = await this.initialize(workspaceRoot)
    const credentials = []
    for (const id of await this.manager.list()) {
      if (!(id.type === 'saved_credential' && id.workspaceId === workspaceId || id.type.startsWith('source_') && id.workspaceId === scope.credentialWorkspaceId)) continue
      const credential = await this.manager.get(id)
      if (credential) credentials.push({ op: 'upsert', id, credential })
    }
    const data = { version: 1, sources: loadWorkspaceSources(workspaceRoot).map(source => source.config),
      automations: await readJson(join(workspaceRoot, 'automations.json'), { automations: {} }), credentials }
    const salt = randomBytes(16), iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv)
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
    return { format: 'tokenbird-shared-resources', version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
  }

  private async import(workspaceId: string, workspaceRoot: string, value: unknown) {
    if (value && typeof value === 'object' && 'encrypted' in value) {
      const { encrypted, password } = z.object({ password: z.string().min(8).max(1024), encrypted: z.object({
        format: z.literal('tokenbird-shared-resources'), version: z.literal(1), salt: z.string().max(64), iv: z.string().max(64), tag: z.string().max(64), ciphertext: z.string().max(16_000_000) }).strict() }).strict().parse(value)
      try {
        const decipher = createDecipheriv('aes-256-gcm', scryptSync(password, Buffer.from(encrypted.salt, 'base64'), 32), Buffer.from(encrypted.iv, 'base64'))
        decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
        const decoded = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]).toString('utf8'))
        const scope = await this.initialize(workspaceRoot)
        for (const change of decoded.credentials ?? []) change.id.workspaceId = change.id.type === 'saved_credential' ? workspaceId : scope.credentialWorkspaceId
        value = decoded
      } catch { throw new Error('Invalid encrypted bundle or password') }
    }
    const bundle = z.object({ version: z.literal(1), sources: z.array(z.unknown()).max(100).default([]),
      automations: z.unknown().optional(), credentials: z.array(z.unknown()).max(100).default([]) }).strict().parse(value)
    // Validate the entire bundle before changing shared resources.
    for (const config of bundle.sources) {
      const validation = validateSourceConfig(config)
      if (!validation.valid) throw new Error(validation.errors.map(issue => `${issue.path}: ${issue.message}`).join('\n'))
      slugSchema.parse((config as FolderSourceConfig).slug)
    }
    const credentials = bundle.credentials.length ? validateNativeCredentialChanges(bundle.credentials) : []
    for (const change of credentials) if (!['saved_credential', 'source_apikey', 'source_bearer', 'source_basic', 'source_oauth'].includes(change.id.type) || change.id.workspaceId !== (change.id.type === 'saved_credential' ? workspaceId : superAgentResourceScope(workspaceRoot).credentialWorkspaceId)) throw new Error('Credential is outside the shared workspace')
    if (bundle.automations !== undefined) {
      const validation = validateAutomationsConfig(bundle.automations)
      if (!validation.valid) throw new Error(validation.errors.join('\n'))
    }
    const knownSources = new Set([...loadWorkspaceSources(workspaceRoot).map(source => source.config.slug), ...bundle.sources.map(source => (source as FolderSourceConfig).slug)])
    const prepared = []
    for (const change of credentials) {
      if (change.id.sourceId && !knownSources.has(change.id.sourceId)) throw new Error('Unknown shared source')
      if (change.op === 'delete') { prepared.push(change); continue }
      const credential = { ...await this.manager.get(change.id), value: '' } as import('@tokenbird/shared/credentials').StoredCredential
      Object.assign(credential, await this.manager.get(change.id))
      for (const [key, field] of Object.entries(change.credential)) {
        if (field === null) delete (credential as unknown as Record<string, unknown>)[key]
        else (credential as unknown as Record<string, unknown>)[key] = field
      }
      if (!credential.value) throw new Error('A non-empty credential secret is required')
      prepared.push({ ...change, credential })
    }
    for (const config of bundle.sources) saveSourceConfig(workspaceRoot, config as FolderSourceConfig)
    if (bundle.automations !== undefined) {
      const validation = validateAutomationsConfig(bundle.automations)
      await atomicJson(join(workspaceRoot, 'automations.json'), validation.config)
    }
    for (const change of prepared) {
      if (change.op === 'delete') await this.manager.delete(change.id)
      else await this.manager.set(change.id, change.credential as import('@tokenbird/shared/credentials').StoredCredential)
    }
  }
}

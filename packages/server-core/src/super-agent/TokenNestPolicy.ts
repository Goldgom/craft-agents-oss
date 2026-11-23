import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { z } from 'zod'
import { TOKENNEST_OAUTH_CONFIG } from '@tokenbird/shared/auth'
import { getLlmConnection, type LlmConnection } from '@tokenbird/shared/config'
import type { SuperAgentConfig } from '@tokenbird/shared/super-agent'
import { tokenNestModelPresets } from '@tokenbird/shared/super-agent/model-presets'

const node = z.object({ name: z.string().trim().max(120).optional(), model: z.string().trim().min(1).max(200), description: z.string().max(4000) })
const policySchema = z.object({
  version: z.literal(1), interaction: node, main: node, dispatch: node,
  includeOtherModels: z.boolean(), workers: z.array(node).max(100),
})

export function applyTokenNestPolicy(config: SuperAgentConfig, connection: LlmConnection, input: unknown): SuperAgentConfig {
  const policy = policySchema.parse(input)
  const group = connection.channelGroups?.find(g => g.id === connection.channelGroup)
  const allowed = new Set(group?.models)
  const catalog = (connection.models ?? []).map(m => typeof m === 'string' ? m : m.id)
    .filter(m => !allowed.size || allowed.has(m))
  const candidates = tokenNestModelPresets({ ...connection, isAuthenticated: true }, catalog, true)
  const models = new Map<string, typeof candidates[number]>()
  for (const entry of candidates) {
    const key = entry.model.toLowerCase()
    if (!models.has(key)) models.set(key, entry)
  }
  const resolve = (selector: string) => {
    const key = selector.toLowerCase()
    const exact = models.get(key)
    if (exact || key !== 'opus') return exact
    return [...models.values()].filter(e => /(?:^|[-/])opus(?:$|[-.])/i.test(e.model))
      .sort((a,b) => b.model.localeCompare(a.model, 'en', { numeric: true }))[0]
  }
  const reserved = new Set<string>()
  const nodes = config.nodes.map(n => {
    if (n.role === 'worker') return n
    const rule = n.role === 'coordinator' ? policy.interaction : n.role === 'planner' ? policy.main : policy.dispatch
    const entry = resolve(rule.model)
    if (!entry) throw new Error(`TokenNest · ${connection.name}: ${rule.model} (model unavailable in selected group)`)
    reserved.add(entry.model)
    return { ...n, name: rule.name || n.name, llmConnection: connection.slug, model: entry.model, description: rule.description, agentRuntime: undefined }
  })
  const workers = new Map<string, { name: string; capabilityNotes: string }>()
  for (const worker of policy.workers) {
    const entry = resolve(worker.model)
    if (entry) workers.set(entry.model, { name: worker.name || entry.model, capabilityNotes: worker.description })
  }
  if (policy.includeOtherModels) {
    for (const entry of models.values()) if (!reserved.has(entry.model) && !workers.has(entry.model)) workers.set(entry.model, { name: entry.name, capabilityNotes: entry.capabilityNotes })
  }
  if (!workers.size) throw new Error('TokenNest: no eligible subagent model in the selected group')
  const existing = new Map(config.modelPool?.filter(e => e.llmConnection === connection.slug).map(e => [e.model, e]))
  const modelPool = [...workers].map(([model, metadata]) => {
    const template = models.get(model.toLowerCase())!
    const old = existing.get(model)
    const id = 'tn-' + createHash('sha256').update(connection.slug + '/' + model).digest('hex').slice(0, 20)
    return { ...(old ?? template), id: old?.id ?? id, enabled: true, ...metadata }
  })
  return { ...config, nodes, modelPool, tokenNestPolicy: { connectionSlug: connection.slug } }
}

export async function loadTokenNestPolicy(workspaceId: string, config: SuperAgentConfig, slug: string) {
  const connection = getLlmConnection(slug)
  if (!connection || connection.oauthProvider !== 'tokennest') throw new Error('Sign in to TokenNest to use one-click setup')
  const response = await fetch(new URL('/api/tokenbird/super-agent-policy', TOKENNEST_OAUTH_CONFIG.apiBaseUrl), {
    signal: AbortSignal.timeout(12_000), redirect: 'error', credentials: 'omit',
  })
  if (!response.ok) throw new Error(`TokenNest policy: HTTP ${response.status}`)
  const next = applyTokenNestPolicy(config, connection, await response.json())
  if (!next.environment.workingDirectory) {
    const folder = join(homedir(), 'TokenBird Projects', createHash('sha256').update(workspaceId).digest('hex').slice(0, 16))
    await mkdir(folder, { recursive: true })
    next.environment = { ...next.environment, workingDirectory: folder }
  }
  return next
}

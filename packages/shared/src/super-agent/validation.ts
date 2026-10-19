import { z } from 'zod'
import { SuperAgentLibraryCommandSchemas } from './library'
import { SuperAgentPlanBlockerSchema } from './blockers'
import { THINKING_LEVEL_IDS } from '../agent/thinking-levels'
import { SuperAgentModelEntrySchema } from './dynamic'
import type { SuperAgentCommand, SuperAgentConfig, SuperAgentState } from './types'

const id = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/)
  .refine(value => !['__proto__', 'prototype', 'constructor', 'user', 'system', 'all'].includes(value), 'Reserved identifier')
const name = z.string().trim().min(1).max(120)
const slug = z.string().trim().min(1).max(200)
const avatar = z.string().max(2_000_000)
const text = z.string().trim().min(1).max(32_000)
const list = z.array(slug).max(100)
const skillSlug = slug.refine(value => !/[\\/:\0]/.test(value) && value !== '.' && value !== '..', 'Skill must be a directory slug')

const ConfigSchema = z.object({
  version: z.literal(1),
  architecture: z.literal('dynamic').optional(),
  maxConcurrentSubagents: z.number().int().min(1).max(30).optional(),
  reportCheckSeconds: z.number().int().min(1).max(3600).optional(),
  modelPool: z.array(SuperAgentModelEntrySchema).min(1).max(100).optional(),
  name,
  avatar,
  nodes: z.array(z.object({
    id, role: z.enum(['coordinator', 'orchestrator', 'worker']), name, avatar,
    dynamic: z.boolean().optional(), modelEntryId: id.optional(),
    description: z.string().max(4_000),
    llmConnection: slug, model: slug,
    agentRuntime: z.union([z.enum(['pi', 'claude-code', 'codex']), z.string().regex(/^plugin:[a-z0-9][a-z0-9_-]*$/).max(200).transform(value => value as `plugin:${string}`)]).optional(),
    skillSlugs: z.array(skillSlug).max(100).optional(),
    defaultSkillSlugs: z.array(skillSlug).max(100).optional(),
    thinkingLevel: z.enum(THINKING_LEVEL_IDS),
    maxCallsPerMinute: z.number().finite().min(0.1).max(60),
    intelligenceRating: z.number().int().min(1).max(5),
    workPreferences: z.string().max(4_000),
    sourceSlugs: list,
    abilityProfileIds: z.array(id).max(100),
    capabilities: z.array(slug).max(32).optional(),
    presetProfile: slug.optional(), thinkingMode: z.enum(['fixed', 'task']).optional(),
  }).strict()).min(2).max(502),
  idleInspectionMinutes: z.number().finite().int().min(1).max(1_440),
  workflow: z.object({ pattern: z.enum(['lightweight', 'development', 'research', 'deliverables', 'incident']),
    maxParallelTasks: z.number().int().min(1).max(30), independentReview: z.boolean() }).strict().optional(),
  continuousWork: z.boolean().default(true),
  requirements: z.object({ programs: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/)).max(32), browser: z.boolean() }).strict().optional(),
  execution: z.object({ connectionConcurrency: z.number().int().min(1).max(30), connectionCallsPerMinute: z.number().int().min(1).max(600),
    stallMinutes: z.number().int().min(1).max(1440), maxResumeAttempts: z.number().int().min(0).max(20) }).strict().optional(),
  environment: z.object({
    kind: z.enum(['folder', 'sandbox', 'vm']),
    workingDirectory: z.string().trim().min(1).max(4_096),
    // Accept legacy documents, then reconcile every node to the team's Execute mode.
    permissionMode: z.enum(['safe', 'ask', 'allow-all']).default('allow-all').transform(() => 'allow-all' as const),
    fullControl: z.boolean().default(true),
    credentialAccess: z.boolean().optional(),
    safety: z.object({
      autoReview: z.boolean(),
      customRules: z.array(z.object({ toolName: slug, effect: z.enum(['deny', 'require-human']), reason: z.string().trim().min(1).max(2_000) }).strict()).max(100),
    }).strict().optional(),
    permissions: z.object({ readFiles: z.boolean(), writeFiles: z.boolean(), runPrograms: z.boolean(), browser: z.boolean() }).strict(),
    sandbox: z.object({ runtime: z.enum(['docker', 'podman']), image: slug }).strict().optional(),
    vm: z.object({ workspaceId: slug }).strict().optional(),
  }).strict(),
  sourceSlugs: list,
  abilityProfiles: z.array(z.object({ id, name, description: z.string().max(4_000), instructions: text }).strict()).max(100),
  scripts: z.array(z.object({
    id, name, path: z.string().trim().min(1).max(4_096),
    args: z.array(z.string().max(4_096)).max(100),
    nodeId: id.optional(), timeoutSeconds: z.number().int().min(1).max(86_400),
  }).strict()).max(100),
}).strict()

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`)
}

export function validateSuperAgentConfig(value: unknown): SuperAgentConfig {
  const config = ConfigSchema.parse(value)
  if (JSON.stringify(config).length > 8 * 1024 * 1024) throw new Error('Super Agent settings must fit within 8 MB; reduce avatar sizes or ability instructions')
  if (config.nodes.filter(node => node.role === 'coordinator').length !== 1) throw new Error('Super Agent requires exactly one coordinator')
  if (config.architecture === 'dynamic') {
    if (!config.modelPool?.some(entry => entry.enabled)) throw new Error('Enable at least one subagent model')
    if (config.nodes.filter(node => node.role === 'orchestrator').length !== 1) throw new Error('Dynamic Super Agent requires exactly one background node')
    if (config.nodes.some(node => node.role === 'worker' && !node.dynamic)) throw new Error('Dynamic workers must be created by the scheduler')
    unique(config.modelPool.map(entry => entry.id), 'model entries')
    for (const entry of config.modelPool) {
      for (const source of entry.sourceSlugs) if (!config.sourceSlugs.includes(source)) throw new Error(`Model source is outside the Super Agent resource pool: ${source}`)
    }
  } else if (!config.nodes.some(node => node.role === 'worker')) throw new Error('Super Agent requires at least one worker')
  if (config.nodes.filter(node => node.role === 'orchestrator').length > 1) throw new Error('Super Agent supports one orchestrator')
  unique(config.nodes.map(node => node.id), 'node identifiers')
  unique(config.abilityProfiles.map(profile => profile.id), 'ability profile identifiers')
  unique(config.scripts.map(script => script.id), 'script identifiers')
  unique(config.sourceSlugs, 'shared sources')
  const nodes = new Set(config.nodes.map(node => node.id))
  const profiles = new Set(config.abilityProfiles.map(profile => profile.id))
  const allowedSources = new Set(config.sourceSlugs)
  for (const node of config.nodes) {
    unique(node.sourceSlugs, 'node sources')
    unique(node.skillSlugs ?? [], 'node skills')
    unique(node.defaultSkillSlugs ?? [], 'node default skills')
    for (const slug of node.sourceSlugs) if (!allowedSources.has(slug)) throw new Error(`Node source is outside the team authorization pool: ${slug}`)
    unique(node.abilityProfileIds, 'node ability profiles')
    for (const profileId of node.abilityProfileIds) if (!profiles.has(profileId)) throw new Error(`Unknown ability profile: ${profileId}`)
  }
  for (const script of config.scripts) {
    if (script.nodeId && !nodes.has(script.nodeId)) throw new Error(`Unknown script node: ${script.nodeId}`)
  }
  if (config.environment.kind === 'sandbox' && !config.environment.sandbox) throw new Error('Sandbox runtime and image are required')
  if (config.environment.kind === 'vm' && !config.environment.vm) throw new Error('A VM workspace is required')
  return config
}

const CommandSchema = z.discriminatedUnion('type', [
  ...SuperAgentLibraryCommandSchemas,
  z.object({ type: z.literal('reset'), confirmed: z.literal(true), preserveConfig: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('environment-check'), config: ConfigSchema }).strict(),
  z.object({ type: z.literal('chat'), text, attachments: z.array(z.object({ name: z.string().min(1).max(255), mimeType: z.string().max(200), text: z.string().max(20_000_000).optional(), base64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(28_000_000).optional() }).strict().refine(file => file.text !== undefined || file.base64 !== undefined, 'Attachment content is required')).max(10).optional() }).strict(),
  z.object({ type: z.literal('resources'), operation: z.enum(['get', 'export', 'import', 'save-sources', 'save-automations', 'save-credentials', 'test-automation', 'replay-automation']), value: z.unknown().optional() }).strict(),
  z.object({ type: z.literal('automation-work'), text, automationId: slug, runId: slug }).strict(),
  z.object({ type: z.literal('task'), id: id.optional(), title: name, instructions: text, nodeId: id.optional(), planId: id.optional(),
    modelEntryId: id.optional(),
    thinkingLevel: z.enum(THINKING_LEVEL_IDS).optional(),
    goalId: id.optional(), requiredCapabilities: z.array(slug).max(32).optional(),
    goalCriteria: z.array(z.number().int().min(0).max(15)).max(16).optional(),
    dependsOn: z.array(id).max(32).optional(), resources: z.array(slug).max(32).optional(),
    acceptanceCriteria: z.array(text).max(16).optional(), requiresIndependentReview: z.boolean().optional(), reviewOf: id.optional() }).strict(),
  z.object({ type: z.literal('continuous-work'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('plan-upsert'), item: z.object({ id: id.optional(), goalId: id.optional(), title: name, instructions: text, status: z.enum(['planned', 'active', 'blocked', 'completed', 'cancelled']), priority: z.number().int().min(1).max(5), note: z.string().max(4_000), blocker: SuperAgentPlanBlockerSchema.optional() }).strict(), expectedRevision: z.number().int().min(0) }).strict(),
  z.object({ type: z.literal('task-resume'), taskId: id }).strict(),
  z.object({ type: z.literal('plan-delete'), id, expectedRevision: z.number().int().min(1) }).strict(),
  z.object({ type: z.literal('cancel'), taskId: id.optional() }).strict(),
  z.object({ type: z.literal('inspect') }).strict(),
  z.object({ type: z.literal('node-refresh'), nodeId: id }).strict(),
  z.object({ type: z.literal('node-reset'), nodeId: id, confirmed: z.literal(true) }).strict(),
  z.object({ type: z.literal('history-cleanup'), before: z.number().finite().min(0), keepRecentMessages: z.number().int().min(0).max(500), expectedRevision: z.number().int().min(0) }).strict(),
  z.object({ type: z.literal('history-compact'), nodeIds: z.array(id).min(1).max(32), expectedRevision: z.number().int().min(0) }).strict(),
  z.object({ type: z.literal('history-delete-sessions'), sessions: z.array(z.object({ id: z.string().trim().min(1).max(200), lastMessageAt: z.number().finite().min(0) }).strict()).min(1).max(100), before: z.number().finite().min(0), expectedRevision: z.number().int().min(0) }).strict(),
  z.object({ type: z.literal('permission-response'), requestId: z.string().trim().min(1).max(200), allowed: z.boolean(), remember: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('permission-revoke'), grantId: id }).strict(),
  z.object({ type: z.literal('message'), fromNodeId: id, toNodeId: z.union([id, z.literal('all')]), body: text }).strict(),
  z.object({ type: z.literal('board-upsert'), item: z.object({ id: id.optional(), title: name, content: text }).strict(), expectedRevision: z.number().int().min(0).optional() }).strict(),
  z.object({ type: z.literal('board-delete'), id, expectedRevision: z.number().int().min(0).optional() }).strict(),
  z.object({ type: z.literal('script-run'), scriptId: id, approval: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), operation: z.string().min(1).max(64_000) }).strict().optional() }).strict(),
  z.object({ type: z.literal('script-stop'), scriptId: id }).strict(),
])

export function validateSuperAgentCommand(value: unknown): SuperAgentCommand {
  return CommandSchema.parse(value)
}

export function emptySuperAgentState(now = Date.now()): SuperAgentState {
  return { version: 1, revision: 0, nodes: [], tasks: [], messages: [], board: [], plans: [], scripts: [], lastUserActivityAt: now }
}

import { z } from 'zod'
import { THINKING_LEVEL_IDS } from '../agent/thinking-levels'
import type { SuperAgentCommand, SuperAgentConfig, SuperAgentState } from './types'

const id = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/)
  .refine(value => !['__proto__', 'prototype', 'constructor', 'user', 'system', 'all'].includes(value), 'Reserved identifier')
const name = z.string().trim().min(1).max(120)
const slug = z.string().trim().min(1).max(200)
const avatar = z.string().max(2_000_000)
const text = z.string().trim().min(1).max(32_000)
const list = z.array(slug).max(100)

const ConfigSchema = z.object({
  version: z.literal(1),
  name,
  avatar,
  nodes: z.array(z.object({
    id, role: z.enum(['coordinator', 'orchestrator', 'worker']), name, avatar,
    description: z.string().max(4_000),
    llmConnection: slug, model: slug,
    thinkingLevel: z.enum(THINKING_LEVEL_IDS),
    maxCallsPerMinute: z.number().finite().min(0.1).max(60),
    intelligenceRating: z.number().int().min(1).max(5),
    workPreferences: z.string().max(4_000),
    sourceSlugs: list,
    abilityProfileIds: z.array(id).max(100),
    capabilities: z.array(slug).max(32).optional(),
  }).strict()).min(2).max(32),
  idleInspectionMinutes: z.number().finite().int().min(1).max(1_440),
  workflow: z.object({ pattern: z.enum(['lightweight', 'development', 'research', 'deliverables', 'incident']),
    maxParallelTasks: z.number().int().min(1).max(30), independentReview: z.boolean() }).strict().optional(),
  continuousWork: z.boolean().default(true),
  execution: z.object({ connectionConcurrency: z.number().int().min(1).max(30), connectionCallsPerMinute: z.number().int().min(1).max(600),
    stallMinutes: z.number().int().min(1).max(1440), maxResumeAttempts: z.number().int().min(0).max(20) }).strict().optional(),
  environment: z.object({
    kind: z.enum(['folder', 'sandbox', 'vm']),
    workingDirectory: z.string().trim().min(1).max(4_096),
    // Accept legacy documents, then reconcile every node to the team's Execute mode.
    permissionMode: z.enum(['safe', 'ask', 'allow-all']).default('allow-all').transform(() => 'allow-all' as const),
    fullControl: z.boolean().default(true),
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
  if (!config.nodes.some(node => node.role === 'worker')) throw new Error('Super Agent requires at least one worker')
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
  z.object({ type: z.literal('chat'), text }).strict(),
  z.object({ type: z.literal('task'), id: id.optional(), title: name, instructions: text, nodeId: id.optional(), planId: id.optional(),
    goalId: id.optional(), requiredCapabilities: z.array(slug).max(32).optional(),
    goalCriteria: z.array(z.number().int().min(0).max(15)).max(16).optional(),
    dependsOn: z.array(id).max(32).optional(), resources: z.array(slug).max(32).optional(),
    acceptanceCriteria: z.array(text).max(16).optional(), requiresIndependentReview: z.boolean().optional(), reviewOf: id.optional() }).strict(),
  z.object({ type: z.literal('continuous-work'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('plan-upsert'), item: z.object({ id: id.optional(), goalId: id.optional(), title: name, instructions: text, status: z.enum(['planned', 'active', 'blocked', 'completed', 'cancelled']), priority: z.number().int().min(1).max(5), note: z.string().max(4_000) }).strict(), expectedRevision: z.number().int().min(0) }).strict(),
  z.object({ type: z.literal('task-resume'), taskId: id }).strict(),
  z.object({ type: z.literal('plan-delete'), id, expectedRevision: z.number().int().min(1) }).strict(),
  z.object({ type: z.literal('cancel'), taskId: id.optional() }).strict(),
  z.object({ type: z.literal('inspect') }).strict(),
  z.object({ type: z.literal('node-refresh'), nodeId: id }).strict(),
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

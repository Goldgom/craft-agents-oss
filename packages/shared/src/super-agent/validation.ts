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
    id, role: z.enum(['coordinator', 'worker']), name, avatar,
    description: z.string().max(4_000),
    llmConnection: slug, model: slug,
    thinkingLevel: z.enum(THINKING_LEVEL_IDS),
    maxCallsPerMinute: z.number().finite().min(0.1).max(60),
    intelligenceRating: z.number().int().min(1).max(5),
    workPreferences: z.string().max(4_000),
    sourceSlugs: list,
    abilityProfileIds: z.array(id).max(100),
  }).strict()).min(2).max(32),
  idleInspectionMinutes: z.number().finite().min(1).max(1_440),
  environment: z.object({
    kind: z.enum(['folder', 'sandbox', 'vm']),
    workingDirectory: z.string().trim().min(1).max(4_096),
    permissionMode: z.enum(['safe', 'ask', 'allow-all']),
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
  z.object({ type: z.literal('task'), title: name, instructions: text, nodeId: id.optional() }).strict(),
  z.object({ type: z.literal('cancel'), taskId: id.optional() }).strict(),
  z.object({ type: z.literal('inspect') }).strict(),
  z.object({ type: z.literal('message'), fromNodeId: id, toNodeId: z.union([id, z.literal('all')]), body: text }).strict(),
  z.object({ type: z.literal('board-upsert'), item: z.object({ id: id.optional(), title: name, content: text }).strict(), expectedRevision: z.number().int().min(0).optional() }).strict(),
  z.object({ type: z.literal('board-delete'), id, expectedRevision: z.number().int().min(0).optional() }).strict(),
  z.object({ type: z.literal('script-run'), scriptId: id }).strict(),
  z.object({ type: z.literal('script-stop'), scriptId: id }).strict(),
])

export function validateSuperAgentCommand(value: unknown): SuperAgentCommand {
  return CommandSchema.parse(value)
}

export function emptySuperAgentState(now = Date.now()): SuperAgentState {
  return { version: 1, revision: 0, nodes: [], tasks: [], messages: [], board: [], scripts: [], lastUserActivityAt: now }
}

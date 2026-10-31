import { z } from 'zod/v3'

export const SuperAgentPlanBlockerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('system'), summary: z.string().trim().min(1).max(500),
    systemAction: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal('user'), summary: z.string().trim().min(1).max(500),
    userAction: z.string().trim().min(1).max(1000), systemAction: z.string().trim().min(1).max(1000).optional() }).strict(),
])
const slug = z.string().trim().min(1).max(200)
const skillSlug = slug.refine(value => !/[\\/:\0]/.test(value) && value !== '.' && value !== '..', 'Skill must be a directory slug')

/** Additive bindings preserve user selections and other agents' resource assignments. */
export const SuperAgentResourceActionSchema = z.object({
  nodeId: z.string().trim().min(1).max(64),
  skillSlugs: z.array(skillSlug).max(100).default([]),
  sourceSlugs: z.array(slug).max(100).default([]),
  reason: z.string().trim().min(1).max(2_000),
}).strict().refine(action => action.skillSlugs.length + action.sourceSlugs.length > 0, 'Select at least one skill or source')

const SuperAgentDeliveryRequestSchema = z.object({ kind: z.enum(['stage', 'final']), title: z.string().trim().min(1).max(120).optional(), artifactIds: z.array(z.string().min(1).max(64)).max(16).optional() }).strict()
const pageQuery = z.object({ offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict()
export const SuperAgentActionsSchema = z.object({
  manageResources: z.array(z.object({ operation: z.enum(['save-sources', 'save-automations', 'save-credentials', 'import']), value: z.unknown() }).strict()).max(4).optional(),
  queryResources: pageQuery.extend({ area: z.enum(['sources', 'credentials', 'automations', 'history']) }).optional(),
  queryWork: pageQuery.optional(),
  queryReports: pageQuery.extend({ afterSequence: z.number().int().min(0).optional() }).optional(),
  reports: z.array(z.object({ kind: z.enum(['progress', 'stage', 'final', 'failure', 'question']), content: z.string().trim().min(1).max(32000),
    taskId: z.string().min(1).max(64).optional(), artifactIds: z.array(z.string().min(1).max(64)).max(100).optional(),
    supersedes: z.string().min(1).max(64).optional() }).strict()).max(8).optional(),
  activateResources: z.array(SuperAgentResourceActionSchema).max(4).optional(),
  intent: z.object({ status: z.enum(['active', 'cancelled']).optional(), id: z.string().max(64).optional(), expectedRevision: z.number().int().min(0).optional(), goal: z.string().trim().min(1).max(16_000), constraints: z.array(z.string().trim().min(1).max(2_000)).max(16), deliverables: z.array(z.string().trim().min(1).max(2_000)).max(16), acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).max(16) }).strict().optional(),
  acceptances: z.array(z.object({ taskId: z.string().min(1).max(64), evidenceTaskId: z.string().min(1).max(64), status: z.enum(['accepted', 'rejected']), note: z.string().trim().min(1).max(4_000) }).strict()).max(4).optional(),
  userReply: z.string().trim().max(32_000).optional(),
  userDelivery: SuperAgentDeliveryRequestSchema.optional(),
  tasks: z.array(z.object({ modelEntryId: z.string().min(1).max(64).optional(), thinkingLevel: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']).optional(), id: z.string().max(64).optional(), goalId: z.string().max(64).optional(), goalCriteria: z.array(z.number().int().min(0).max(15)).max(16).optional(), requiredCapabilities: z.array(z.string().min(1).max(100)).max(32).optional(), dependsOn: z.array(z.string().max(64)).max(32).optional(), resources: z.array(z.string().trim().min(1).max(200)).max(32).optional(), acceptanceCriteria: z.array(z.string().trim().min(1).max(32_000)).max(16).optional(), requiresIndependentReview: z.boolean().optional(), reviewOf: z.string().max(64).optional(), title: z.string().trim().min(1).max(120), instructions: z.string().trim().min(1).max(32_000), nodeId: z.string().max(64).optional(), planId: z.string().max(64).optional() }).strict()).max(4).optional(),
  plans: z.array(z.object({ id: z.string().max(64).optional(), goalId: z.string().max(64).optional(), title: z.string().trim().min(1).max(120), instructions: z.string().trim().min(1).max(32_000), status: z.enum(['planned', 'active', 'blocked', 'completed', 'cancelled']), priority: z.number().int().min(1).max(5), note: z.string().max(4_000), blocker: SuperAgentPlanBlockerSchema.optional(), expectedRevision: z.number().int().min(0) }).strict()).max(8).optional(),
  messages: z.array(z.object({ toNodeId: z.string().min(1).max(64), body: z.string().trim().min(1).max(32_000) }).strict()).max(8).optional(),
  board: z.array(z.object({ id: z.string().max(64).optional(), title: z.string().trim().min(1).max(120), content: z.string().trim().min(1).max(32_000), expectedRevision: z.number().int().min(0) }).strict()).max(8).optional(),
  registerScripts: z.array(z.object({ id: z.string().max(64), name: z.string().trim().min(1).max(120), path: z.string().trim().min(1).max(4_096), args: z.array(z.string().max(4_096)).max(100), timeoutSeconds: z.number().int().min(1).max(86_400) }).strict()).max(4).optional(),
  runScripts: z.array(z.string().max(64)).max(4).optional(),
}).strict()

export const SUPER_AGENT_COLLABORATION_SKILL = 'super-agent-collaboration'
export type SuperAgentActions = z.infer<typeof SuperAgentActionsSchema>
export function isSuperAgentToolValidationError(error: unknown): error is z.ZodError {
  return error instanceof z.ZodError
}
const requestId = z.string().trim().min(1).max(64).describe('Unique ID for this operation in the current turn. Reuse it only to retry identical parameters; changed parameters need a new ID.')
const field = SuperAgentActionsSchema.shape
// Each tool advertises its own complete contract, without a JSON string envelope.
export const SUPER_AGENT_ACTION_TOOLS = [
  { name: 'super_agent_manage_resources', description: 'Manage the workspace resources shared with all agents. save-sources: {configs: FolderSourceConfig[], deletedSlugs?: string[]}; save-automations: AutomationsConfig; save-credentials: native credential changes [{op: upsert|delete, id, credential?}] using workspace ID for saved_credential and catalog credentialWorkspaceId for source credentials. import: {version:1,sources?:FolderSourceConfig[],automations?:AutomationsConfig,credentials?:changes[]}. Secrets are write-only. Read the catalog first and preserve unrelated configuration.', inputSchema: z.object({ requestId, ...field.manageResources.unwrap().element.shape }).strict(), field: 'manageResources', array: true },
  { name: 'super_agent_resource_catalog', description: 'Read shared workspace source, credential metadata, automation definitions or run history. Credential values and webhook secrets are never returned.', inputSchema: z.object({ requestId, ...field.queryResources.unwrap().shape }).strict(), field: 'queryResources', array: false },
  { name: 'super_agent_work_list', description: 'Read the complete shared work list: user requirements, execution plans and task contracts. Paginated; all team nodes can read it. Contains no private worker transcript or tool output.', inputSchema: z.object({ requestId, ...field.queryWork.unwrap().shape }).strict(), field: 'queryWork', array: false },
  { name: 'super_agent_reports', description: 'Read the report area, optionally after a sequence number. Interaction uses these reports to communicate results. Verification state is authoritative; unverified reports are not proof of completion.', inputSchema: z.object({ requestId, ...field.queryReports.unwrap().shape }).strict(), field: 'queryReports', array: false },
  { name: 'super_agent_report', description: 'Worker or background node: append a report directly to the interaction report area. Include evidence artifact IDs and identify progress, stage result, final result, failure or question. Final means the assigned scope is finished. A stage report alone does not keep a task active: ongoing work must checkpoint and register a supported wait before ending the active task turn. A message turn cannot report for a completed worker task. The host determines verification.', inputSchema: z.object({ requestId, ...field.reports.unwrap().element.shape }).strict(), field: 'reports', array: true },
  { name: 'super_agent_intent', description: 'Interaction node: hand off or revise the authorized user goal. Include id and its latest expectedRevision only when revising an existing goal.', inputSchema: z.object({ requestId, ...field.intent.unwrap().shape }).strict(), field: 'intent', array: false },
  { name: 'super_agent_dispatch', description: 'Orchestrator: create a subagent for one bounded task. For dynamic teams, modelEntryId and thinkingLevel are required; nodeId is omitted. Use stable id, dependencies and concrete acceptance criteria. Default to executor self-checks; set requiresIndependentReview or create reviewOf tasks only when the user explicitly requests independent review. Criteria alone do not require acceptance before downstream work. Queued work is not completed work.', inputSchema: z.object({ requestId, ...field.tasks.unwrap().element.shape }).strict(), field: 'tasks', array: true },
  { name: 'super_agent_plan', description: 'Orchestrator: create or replace one plan. New expectedRevision=0; updates require the latest revision. Read the complete plan before replacing it.', inputSchema: z.object({ requestId, ...field.plans.unwrap().element.shape }).strict(), field: 'plans', array: true },
  { name: 'super_agent_message', description: 'Send one concise internal message to an existing team node using toNodeId. No external communication. Reports should reference artifact or board IDs instead of repeating history.', inputSchema: z.object({ requestId, ...field.messages.unwrap().element.shape }).strict(), field: 'messages', array: true },
  { name: 'super_agent_board', description: "Create or replace one durable shared-board item. New expectedRevision=0; updates require id and latest revision. Read collaboration_board first and preserve other nodes' valid content.", inputSchema: z.object({ requestId, ...field.board.unwrap().element.shape }).strict(), field: 'board', array: true },
  { name: 'super_agent_accept', description: 'Orchestrator: record accepted/rejected work against completed evidence for the current goal and artifact version. Unsettled operations require independent verification and reconciliation first.', inputSchema: z.object({ requestId, ...field.acceptances.unwrap().element.shape }).strict(), field: 'acceptances', array: true },
  { name: 'super_agent_resources', description: 'Orchestrator: activate installed skills and authorized sources for an idle worker. Workers may activate only their own resources, then end this turn; the host resumes the original task with refreshed tools.', inputSchema: z.object({ requestId, nodeId: z.string().trim().min(1).max(64), skillSlugs: z.array(skillSlug).max(100).optional(), sourceSlugs: z.array(slug).max(100).optional(), reason: z.string().trim().min(1).max(2000) }).strict(), field: 'activateResources', array: true },
  { name: 'super_agent_deliver', description: 'Interaction node: submit a user-facing reply, optionally a stage/final delivery referencing registered artifact IDs. reply="" keeps an internal turn silent. The host publishes the reply only when this turn completes successfully.', inputSchema: z.object({ requestId, reply: z.string().trim().max(32000), delivery: SuperAgentDeliveryRequestSchema.optional() }).strict(), field: 'userReply', array: false },
  { name: 'super_agent_script', description: 'Worker: register one generated script without execution, or start one assigned script. Running still requires the current environment and authorization; this tool cannot approve a script.', inputSchema: z.object({ requestId, action: z.enum(['register', 'run']), script: field.registerScripts.unwrap().element.optional(), scriptId: z.string().min(1).max(64).optional() }).strict(), field: 'registerScripts', array: true },
] as const
export type SuperAgentActionToolName = typeof SUPER_AGENT_ACTION_TOOLS[number]['name']
export function parseSuperAgentToolCall(toolName: string, input: unknown) {
  const tool = SUPER_AGENT_ACTION_TOOLS.find(tool => tool.name === toolName)
  if (!tool) throw new Error('Unknown Super Agent collaboration tool')
  const { requestId, ...args } = tool.inputSchema.parse(input) as Record<string, unknown> & { requestId: string }
  let actions: unknown
  if (toolName === 'super_agent_deliver') actions = { userReply: args.reply, userDelivery: args.delivery }
  else if (toolName === 'super_agent_script') {
    if (args.action === 'register' && args.script && !args.scriptId) actions = { registerScripts: [args.script] }
    else if (args.action === 'run' && args.scriptId && !args.script) actions = { runScripts: [args.scriptId] }
    else throw new Error('register requires script only; run requires scriptId only')
  } else actions = { [tool.field]: tool.array ? [args] : args }
  return { requestId, actions: SuperAgentActionsSchema.parse(actions) }
}

export const SuperAgentSettingsSchema = z.object({
  action: z.enum(['get', 'update']),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  changes: z.record(z.unknown()).optional(),
}).strict()

import type { ThinkingLevel } from '../agent/thinking-levels'
import type { AgentRuntimeProtocol } from '../config/llm-connections'
import type { SuperAgentArchive, SuperAgentMemory, SuperAgentLibraryCommand } from './library'
import type { PermissionMode } from '../agent/mode-types'
import type { SessionPolicyPermissionScope } from '@tokenbird/core/types'
import type { SuperAgentCheckpoint, SuperAgentWaitCondition, SuperAgentArtifact, SuperAgentOperation, SuperAgentMetrics, SuperAgentStatistics } from './continuity'

export type { SessionPolicyPermissionScope } from '@tokenbird/core/types'

/** One persistent model session, with no concurrent turn or delegated subprocess. */
export interface SuperAgentNode {
  /** Created for one assignment, rather than a user-configured permanent worker. */
  dynamic?: boolean
  modelEntryId?: string
  id: string
  role: 'coordinator' | 'orchestrator' | 'worker'
  name: string
  avatar: string
  description: string
  llmConnection: string
  /** Omitted means follow the connection; an explicit backend is local to this node. */
  agentRuntime?: AgentRuntimeProtocol
  /** Reusable skills assigned to this node. Empty or omitted assigns none. */
  skillSlugs?: string[]
  /** Last applied preset defaults; tracks user additions/removals across preset changes. */
  defaultSkillSlugs?: string[]
  model: string
  thinkingLevel: ThinkingLevel
  /** Upper bound on model turns started per minute, not token generation speed. */
  maxCallsPerMinute: number
  intelligenceRating: number
  workPreferences: string
  /** Explicit subset of the team's authorized source pool; empty grants none. */
  sourceSlugs: string[]
  abilityProfileIds: string[]
  capabilities?: string[]
  /** Stable preset responsibility; never infer resource ownership from array order. */
  presetProfile?: string
  /** Missing legacy values allow task overrides. */
  thinkingMode?: 'fixed' | 'task'
}

export interface SuperAgentEnvironment {
  kind: 'folder' | 'sandbox' | 'vm'
  workingDirectory: string
  /** Super Agent normalizes legacy modes to allow-all; capability grants are independent. */
  permissionMode: PermissionMode
  /** Enable worker capabilities and skip all approvals/reviews within the fixed environment. */
  fullControl?: boolean
  /** Workspace vault access, independent of full control. Missing legacy values default to enabled; false explicitly disables it. */
  credentialAccess?: boolean
  safety?: {
    autoReview: boolean
    /** Exact tool names; rules can only restrict the mandatory policy. */
    customRules: Array<{ toolName: string; effect: 'deny' | 'require-human'; reason: string }>
  }
  permissions: {
    readFiles: boolean
    writeFiles: boolean
    runPrograms: boolean
    browser: boolean
  }
  sandbox?: { runtime: 'docker' | 'podman'; image: string }
  vm?: { workspaceId: string }
}

export interface SuperAgentAbilityProfile {
  id: string
  name: string
  description: string
  instructions: string
}

/** Registered files are watched; changes never execute them automatically. */
export interface SuperAgentScript {
  id: string
  name: string
  /** Relative to the environment folder, or an absolute path inside it. */
  path: string
  args: string[]
  nodeId?: string
  timeoutSeconds: number
}

export interface SuperAgentConfig {
  version: 1
  architecture?: 'dynamic'
  maxConcurrentSubagents?: number
  reportCheckSeconds?: number
  modelPool?: SuperAgentModelEntry[]
  name: string
  avatar: string
  nodes: SuperAgentNode[]
  workflow?: {
    pattern: 'lightweight' | 'development' | 'research' | 'deliverables' | 'incident'
    maxParallelTasks: number
    /** Explicit user opt-in to independent review; presets must leave this disabled. */
    independentReview: boolean
  }
  /** Idle inspection interval in minutes (1–1440), including continuous work reviews. */
  idleInspectionMinutes: number
  /** Wake after idleInspectionMinutes of complete team inactivity. Defaults to true. */
  continuousWork?: boolean
  /** Checked between node turns; omitted legacy settings enable the defaults. */
  contextCompaction?: { enabled: boolean; tokenThreshold: number; saveToMemory: boolean }
  execution?: {
    connectionConcurrency: number
    connectionCallsPerMinute: number
    stallMinutes: number
    maxResumeAttempts: number
  }
  requirements?: { programs: string[]; browser: boolean }
  environment: SuperAgentEnvironment
  /** Sources available for assignment; individual nodes need their own binding. */
  sourceSlugs: string[]
  abilityProfiles: SuperAgentAbilityProfile[]
  scripts: SuperAgentScript[]
}

export type SuperAgentTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/** Durable record of the control actions applied to one model turn. */
export interface SuperAgentActionReceipt {
  turnId: string
  status: 'applied' | 'rejected' | 'partially_applied'
  applied: Array<{ id: string; type: string; targetId?: string }>
  rejected?: { id: string; type: string; targetId?: string; error: string }
  notAttempted?: Array<{ id: string; type: string; targetId?: string }>
  createdAt: number
}

export interface SuperAgentTask {
  modelEntryId?: string
  thinkingLevel?: ThinkingLevel
  id: string
  /** Durable dependency and exclusive resource contracts, enforced before dispatch. */
  dependsOn?: string[]
  resources?: string[]
  acceptanceCriteria?: string[]
  /** Set only when the user explicitly requests independent review. Criteria alone do not enable it. */
  requiresIndependentReview?: boolean
  /** An independent verifier may read a submitted result before acceptance. */
  reviewOf?: string
  acceptance?: { status: 'accepted' | 'rejected' | 'stale'; evidenceTaskId: string; note: string; reviewedBy: string; reviewedAt: number; artifactHashes?: Array<{ id: string; sha256: string }> }
  goalId?: string
  goalRevision?: number
  requiredCapabilities?: string[]
  goalCriteria?: number[]
  phase?: 'executing' | 'waiting' | 'outcome-unknown' | 'submitted'
  checkpoint?: SuperAgentCheckpoint
  waiting?: { reason: string; condition: SuperAgentWaitCondition; since: number; resumeAttempts: number }
  lastProgressAt?: number
  lastResultHash?: string
  stallNotifiedAt?: number
  attempt?: number
  artifactIds?: string[]
  inputArtifacts?: Array<{ id: string; sha256: string }>
  planId?: string
  title: string
  instructions: string
  nodeId: string
  /** Session that actually executed this task, retained across node edits. */
  sessionId?: string
  status: SuperAgentTaskStatus
  createdAt: number
  startedAt?: number
  completedAt?: number
  output?: string
  error?: string
  /** A submitted result does not imply its requested actions succeeded. */
  actionReceipt?: SuperAgentActionReceipt
}

export interface SuperAgentNodeRuntime {
  nodeId: string
  /** Prevent repeated compaction of an unchanged provider usage snapshot, including after restart. */
  lastAutoCompactUsage?: string
  /** Consecutive suppressed duplicate responses; rotate the model context after two. */
  repeatedResponses?: number
  sessionId?: string
  status: 'idle' | 'preparing' | 'working' | 'recovering' | 'error'
  retryAt?: number
  retryAttempt?: number
  retryDeadline?: number
  activeTaskId?: string
  lastStartedAt?: number
  lastCompletedAt?: number
  /** Bounded diagnostics from the real workflow SDK, never a dispatch/recovery authority. */
  workflow?: { turnId: string; events: Array<{ type: string; executorId?: string; state?: string; at: number }> }
  error?: string
}

export interface SuperAgentMessage {
  id: string
  /** Evidence snapshot for response deduplication; not an execution authority. */
  responseProgressKey?: string
  fromNodeId: string | 'user' | 'system'
  toNodeId: string | 'user' | 'all'
  kind: 'chat' | 'message' | 'task' | 'result' | 'inspection' | 'script' | 'error'
  body: string
  taskId?: string
  createdAt: number
  /** Explicitly selected for the user, including useful background replies. */
  userFacing?: boolean
  /** Explicit stage interaction or final handoff, selected by the intent node. */
  delivery?: import('./delivery').SuperAgentDelivery
  /** Actual host outcome of model control actions, independent of prose claims. */
  actionReceipt?: SuperAgentActionReceipt
  /** Durable display record; never used to restore or grant an approval. */
  permission?: SuperAgentPermissionRecord
}

export type SuperAgentPermissionRecord = Pick<SuperAgentPermissionRequest,
  'id' | 'nodeId' | 'toolName' | 'description' | 'command' | 'reason' | 'status' | 'resolvedAt'> & {
  target?: string
  operation?: string
}

export interface SuperAgentBoardItem {
  id: string
  title: string
  content: string
  revision: number
  updatedBy: string
  updatedAt: number
}

export interface SuperAgentPlanItem {
  id: string
  goalId?: string
  goalRevision?: number
  title: string
  instructions: string
  status: 'planned' | 'active' | 'blocked' | 'completed' | 'cancelled'
  /** 1 is the highest priority. */
  priority: number
  note: string
  blocker?: import('./blockers').SuperAgentPlanBlocker
  revision: number
  updatedBy: string
  updatedAt: number
}

export interface SuperAgentScriptRuntime {
  scriptId: string
  /** Unique execution identity; never restore or replay the previous process. */
  runId?: string
  /** Assignment that required this run; absent for manual launches. */
  taskId?: string
  planId?: string
  /** Persist a terminal result until its coordinator summary has been queued. */
  resultPending?: boolean
  /** A queued summary is not acknowledged until its coordinator turn succeeds. */
  resultQueuedAt?: number
  resultReportedAt?: number
  /** Bounded automatic delivery attempts; an explicit user continuation may reset them. */
  resultDeliveryAttempts?: number
  resultDeliveryPaused?: boolean
  resultDeliveryError?: string
  status: 'idle' | 'running' | 'completed' | 'failed' | 'stopped' | 'missing' | 'untracked'
  changedAt?: number
  lastModifiedAt?: number
  sha256?: string
  startedAt?: number
  completedAt?: number
  exitCode?: number | null
  /** Signal termination has a null exit code on POSIX. */
  exitSignal?: string
  output?: string
  error?: string
}

export interface SuperAgentState {
  reports?: SuperAgentReport[]
  reportSequence?: number
  consumedReportSequence?: number
  lastReportCheckAt?: number
  events?: SuperAgentWorkEvent[]
  eventSequence?: number
  consumedEventSequence?: number
  version: 1
  revision: number
  nodes: SuperAgentNodeRuntime[]
  tasks: SuperAgentTask[]
  messages: SuperAgentMessage[]
  board: SuperAgentBoardItem[]
  /** Workspace libraries survive runtime history cleanup and node session replacement. */
  memories?: SuperAgentMemory[]
  archives?: SuperAgentArchive[]
  plans: SuperAgentPlanItem[]
  intents?: SuperAgentIntent[]
  artifacts?: SuperAgentArtifact[]
  operations?: SuperAgentOperation[]
  metrics?: SuperAgentMetrics
  statistics?: SuperAgentStatistics
  connectionStarts?: Array<{ connection: string; at: number }>
  scripts: SuperAgentScriptRuntime[]
  permissionGrants?: SuperAgentPermissionGrant[]
  lastUserActivityAt: number
  lastInspectionAt?: number
  allIdleSince?: number
}

/** User-facing intent is handed to planning without granting new authority. */
export interface SuperAgentIntent {
  id: string
  revision?: number
  status?: 'active' | 'delivered' | 'cancelled'
  goal: string
  constraints: string[]
  deliverables: string[]
  acceptanceCriteria: string[]
  createdAt: number
  sourceTurnId: string
}

export interface SuperAgentTaskContract {
  modelEntryId?: string
  thinkingLevel?: ThinkingLevel
  id?: string
  goalId?: string
  requiredCapabilities?: string[]
  goalCriteria?: number[]
  title: string
  instructions: string
  nodeId?: string
  planId?: string
  dependsOn?: string[]
  resources?: string[]
  acceptanceCriteria?: string[]
  requiresIndependentReview?: boolean
  reviewOf?: string
}

export interface SuperAgentEnvironmentStatus {
  available: boolean
  /** Folder policy is not an operating system sandbox. */
  isolation: 'host-folder' | 'container' | 'remote-vm' | 'unavailable'
  detail: string
}

export interface SuperAgentSnapshot {
  resources?: unknown
  /** A user-requested inspection is queued or executing, including retry delays. */
  inspectionPending?: boolean
  /** The interaction node has a queued or executing turn, independent of background work. */
  interactionPending?: boolean
  /** Explicit user stop pauses internal verification until work is resumed. */
  recoverySuspended?: boolean
  readiness?: SuperAgentReadiness
  config: SuperAgentConfig | null
  state: SuperAgentState
  environment: SuperAgentEnvironmentStatus
  /** Live provider output and tool events; deliberately not persisted as a second transcript. */
  activity?: SuperAgentNodeActivity[]
  permissionRequests?: SuperAgentPermissionRequest[]
  historyCleanup?: SuperAgentHistoryCleanupResult
}

export interface SuperAgentReadiness {
  ready: boolean
  checkedAt: number
  checks: Array<{ id: string; ok: boolean; detail: string }>
}

export interface SuperAgentHistoryCleanupResult {
  mode: 'runtime' | 'compact' | 'sessions'
  tasks: number
  messages: number
  plans: number
  scriptLogs: number
  sessions: number
  queued: number
  archivePath?: string
  failures: Array<{ sessionId: string; error: string }>
}

export interface SuperAgentActivityEntry {
  id: string
  kind: 'thinking' | 'text' | 'tool' | 'status' | 'error'
  text: string
  createdAt: number
  updatedAt: number
  toolName?: string
  toolUseId?: string
  status?: 'running' | 'completed' | 'failed'
  turnId?: string
}

export interface SuperAgentNodeActivity {
  nodeId: string
  sessionId: string
  taskId?: string
  status: 'working' | 'recovering' | 'waiting_permission' | 'error'
  startedAt: number
  updatedAt: number
  entries: SuperAgentActivityEntry[]
}

export interface SuperAgentPermissionRequest {
  id: string
  nodeId: string
  coordinatorId: string
  sessionId: string
  taskId?: string
  toolName: string
  description: string
  command?: string
  reason?: string
  scope?: SessionPolicyPermissionScope
  status: 'pending' | 'approved' | 'denied' | 'expired'
  createdAt: number
  resolvedAt?: number
}

export interface SuperAgentPermissionGrant {
  id: string
  nodeId: string
  description: string
  scope: Omit<SessionPolicyPermissionScope, 'expiresAt'>
  environmentKey: string
  createdAt: number
}

/** Model output uses the same bounded operations as the user-facing control API. */
export type SuperAgentCommand =
  | SuperAgentLibraryCommand
  | { type: 'reset'; confirmed: true; preserveConfig?: boolean }
  | { type: 'environment-check'; config: SuperAgentConfig }
  | { type: 'chat'; text: string; attachments?: Array<{ name: string; mimeType: string; text?: string; base64?: string }> }
  | { type: 'resources'; operation: 'get' | 'export' | 'import' | 'save-sources' | 'save-automations' | 'save-credentials' | 'test-automation' | 'replay-automation'; value?: unknown }
  | { type: 'automation-work'; text: string; automationId: string; runId: string }
  | ({ type: 'task' } & SuperAgentTaskContract)
  | { type: 'continuous-work'; enabled: boolean }
  | { type: 'plan-upsert'; item: Pick<SuperAgentPlanItem, 'title' | 'instructions' | 'status' | 'priority' | 'note' | 'goalId' | 'blocker'> & { id?: string }; expectedRevision: number }
  | { type: 'task-resume'; taskId: string }
  | { type: 'plan-delete'; id: string; expectedRevision: number }
  | { type: 'cancel'; taskId?: string }
  | { type: 'inspect' }
  | { type: 'node-refresh'; nodeId: string }
  | { type: 'node-reset'; nodeId: string; confirmed: true }
  | { type: 'history-cleanup'; before: number; keepRecentMessages: number; expectedRevision: number }
  | { type: 'history-compact'; nodeIds: string[]; expectedRevision: number }
  | { type: 'history-delete-sessions'; sessions: Array<{ id: string; lastMessageAt: number }>; before: number; expectedRevision: number }
  | { type: 'permission-response'; requestId: string; allowed: boolean; remember?: boolean }
  | { type: 'permission-revoke'; grantId: string }
  | { type: 'message'; fromNodeId: string; toNodeId: string; body: string }
  | { type: 'board-upsert'; item: { id?: string; title: string; content: string }; expectedRevision?: number }
  | { type: 'board-delete'; id: string; expectedRevision?: number }
  | { type: 'script-run'; scriptId: string; approval?: { sha256: string; operation: string } }
  | { type: 'script-stop'; scriptId: string }

/** The execution host must enforce this before model tools are dispatched. */
export interface SuperAgentSessionPolicy {
  architecture?: 'dynamic'
  /** Host-selected resource workspace; never accepted from model tool arguments. */
  resourceScope?: 'super-agent'
  /** Host-selected shared skill catalog; sources and credentials retain their own scope. */
  skillWorkspaceRootPath?: string
  nodeId: string
  role: SuperAgentNode['role']
  rootPath: string
  /** Enable worker capabilities and skip all approvals/reviews within the fixed environment. */
  fullControl?: boolean
  credentialAccess?: boolean
  /** Host-enforced, never configurable by a model or delegation. */
  actionGates?: true
  safety?: SuperAgentEnvironment['safety']
  /** Original user messages selected by the host, not model-written authorization. */
  userIntent?: string
  /** Host-owned control/credential directories, never mounted into worker code. */
  protectedRoots?: string[]
  readFiles: boolean
  writeFiles: boolean
  runPrograms: boolean
  browser: boolean
  allowSources: string[]
  allowSkills?: string[]
  agentRuntime?: AgentRuntimeProtocol
  allowSubagents: false
  /** Runtime-only verified container; never persist a stale container identity. */
  containerExecutor?: { runtimePath: string; containerId: string; workingDirectory: string }
}

export interface SuperAgentModelEntry {
  id: string
  name: string
  llmConnection: string
  model: string
  agentRuntime?: AgentRuntimeProtocol
  /** Unified strengths, limitations, tags and selection notes; data, not work instructions. */
  capabilityNotes: string
  /** User-adjustable selection score, not a published benchmark. */
  intelligenceScore: number
  enabled: boolean
  supportedThinkingLevels: ThinkingLevel[]
  skillSlugs: string[]
  sourceSlugs: string[]
  capabilities: string[]
  maxCallsPerMinute: number
}

export interface SuperAgentReport {
  id: string
  sequence: number
  nodeId: string
  turnId: string
  taskId?: string
  goalId?: string
  goalRevision?: number
  kind: 'progress' | 'stage' | 'final' | 'failure' | 'question'
  content: string
  verification: 'unverified' | 'verified' | 'stale'
  artifactIds: string[]
  supersedes?: string
  createdAt: number
}

export interface SuperAgentWorkEvent {
  id: string
  sequence: number
  kind: 'work' | 'board' | 'report' | 'runtime' | 'automation'
  actor: string
  targetId?: string
  revision: number
  createdAt: number
}

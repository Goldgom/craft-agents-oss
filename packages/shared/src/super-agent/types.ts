import type { ThinkingLevel } from '../agent/thinking-levels'
import type { SuperAgentArchive, SuperAgentMemory, SuperAgentLibraryCommand } from './library'
import type { PermissionMode } from '../agent/mode-types'
import type { SessionPolicyPermissionScope } from '@craft-agent/core/types'
import type { SuperAgentCheckpoint, SuperAgentWaitCondition, SuperAgentArtifact, SuperAgentOperation, SuperAgentMetrics, SuperAgentStatistics } from './continuity'

export type { SessionPolicyPermissionScope } from '@craft-agent/core/types'

/** One persistent model session, with no concurrent turn or delegated subprocess. */
export interface SuperAgentNode {
  id: string
  role: 'coordinator' | 'orchestrator' | 'worker'
  name: string
  avatar: string
  description: string
  llmConnection: string
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
  name: string
  avatar: string
  nodes: SuperAgentNode[]
  workflow?: {
    pattern: 'lightweight' | 'development' | 'research' | 'deliverables' | 'incident'
    maxParallelTasks: number
    /** Apply independent review to deliverable tasks with declared acceptance criteria. */
    independentReview: boolean
  }
  /** Idle inspection interval in minutes (1–1440), including continuous work reviews. */
  idleInspectionMinutes: number
  /** Wake after idleInspectionMinutes of complete team inactivity. Defaults to true. */
  continuousWork?: boolean
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
  thinkingLevel?: ThinkingLevel
  id: string
  /** Durable dependency and exclusive resource contracts, enforced before dispatch. */
  dependsOn?: string[]
  resources?: string[]
  acceptanceCriteria?: string[]
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
  sessionId?: string
  status: 'idle' | 'preparing' | 'working' | 'recovering' | 'error'
  retryAt?: number
  retryAttempt?: number
  retryDeadline?: number
  activeTaskId?: string
  lastStartedAt?: number
  lastCompletedAt?: number
  error?: string
}

export interface SuperAgentMessage {
  id: string
  fromNodeId: string | 'user' | 'system'
  toNodeId: string | 'user' | 'all'
  kind: 'chat' | 'message' | 'task' | 'result' | 'inspection' | 'script' | 'error'
  body: string
  taskId?: string
  createdAt: number
  /** Explicitly selected for the user, including useful background replies. */
  userFacing?: boolean
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
  | { type: 'reset'; confirmed: true }
  | { type: 'environment-check'; config: SuperAgentConfig }
  | { type: 'chat'; text: string }
  | ({ type: 'task' } & SuperAgentTaskContract)
  | { type: 'continuous-work'; enabled: boolean }
  | { type: 'plan-upsert'; item: Pick<SuperAgentPlanItem, 'title' | 'instructions' | 'status' | 'priority' | 'note' | 'goalId'> & { id?: string }; expectedRevision: number }
  | { type: 'task-resume'; taskId: string }
  | { type: 'plan-delete'; id: string; expectedRevision: number }
  | { type: 'cancel'; taskId?: string }
  | { type: 'inspect' }
  | { type: 'node-refresh'; nodeId: string }
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
  nodeId: string
  role: SuperAgentNode['role']
  rootPath: string
  /** Enable worker capabilities and skip all approvals/reviews within the fixed environment. */
  fullControl?: boolean
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
  allowSubagents: false
  /** Runtime-only verified container; never persist a stale container identity. */
  containerExecutor?: { runtimePath: string; containerId: string; workingDirectory: string }
}

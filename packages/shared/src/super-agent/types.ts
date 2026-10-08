import type { ThinkingLevel } from '../agent/thinking-levels'
import type { PermissionMode } from '../agent/mode-types'
import type { SessionPolicyPermissionScope } from '@craft-agent/core/types'

export type { SessionPolicyPermissionScope } from '@craft-agent/core/types'

/** One persistent model session, with no concurrent turn or delegated subprocess. */
export interface SuperAgentNode {
  id: string
  role: 'coordinator' | 'worker'
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
}

export interface SuperAgentEnvironment {
  kind: 'folder' | 'sandbox' | 'vm'
  workingDirectory: string
  /** Super Agent normalizes legacy modes to allow-all; capability grants are independent. */
  permissionMode: PermissionMode
  /** Explicit opt-in to unrestricted tool access without per-operation approvals. */
  fullControl?: boolean
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
  /** Idle inspection interval in minutes (1–1440), including continuous work reviews. */
  idleInspectionMinutes: number
  /** Wake after idleInspectionMinutes of complete team inactivity. Defaults to true. */
  continuousWork?: boolean
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
  id: string
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
  plans: SuperAgentPlanItem[]
  scripts: SuperAgentScriptRuntime[]
  permissionGrants?: SuperAgentPermissionGrant[]
  lastUserActivityAt: number
  lastInspectionAt?: number
  allIdleSince?: number
}

export interface SuperAgentEnvironmentStatus {
  available: boolean
  /** Folder policy is not an operating system sandbox. */
  isolation: 'host-folder' | 'container' | 'remote-vm' | 'unavailable'
  detail: string
}

export interface SuperAgentSnapshot {
  config: SuperAgentConfig | null
  state: SuperAgentState
  environment: SuperAgentEnvironmentStatus
  /** Live provider output and tool events; deliberately not persisted as a second transcript. */
  activity?: SuperAgentNodeActivity[]
  permissionRequests?: SuperAgentPermissionRequest[]
  historyCleanup?: SuperAgentHistoryCleanupResult
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
  | { type: 'chat'; text: string }
  | { type: 'task'; title: string; instructions: string; nodeId?: string; planId?: string }
  | { type: 'continuous-work'; enabled: boolean }
  | { type: 'plan-upsert'; item: Pick<SuperAgentPlanItem, 'title' | 'instructions' | 'status' | 'priority' | 'note'> & { id?: string }; expectedRevision: number }
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
  | { type: 'script-run'; scriptId: string }
  | { type: 'script-stop'; scriptId: string }

/** The execution host must enforce this before model tools are dispatched. */
export interface SuperAgentSessionPolicy {
  nodeId: string
  role: SuperAgentNode['role']
  rootPath: string
  /** Bypass tool capability and directory restrictions in the selected execution environment. */
  fullControl?: boolean
  readFiles: boolean
  writeFiles: boolean
  runPrograms: boolean
  browser: boolean
  allowSources: string[]
  allowSubagents: false
  /** Runtime-only verified container; never persist a stale container identity. */
  containerExecutor?: { runtimePath: string; containerId: string; workingDirectory: string }
}

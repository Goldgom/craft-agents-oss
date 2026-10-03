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
  idleInspectionMinutes: number
  environment: SuperAgentEnvironment
  /** Sources available for assignment; individual nodes need their own binding. */
  sourceSlugs: string[]
  abilityProfiles: SuperAgentAbilityProfile[]
  scripts: SuperAgentScript[]
}

export type SuperAgentTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface SuperAgentTask {
  id: string
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
}

export interface SuperAgentNodeRuntime {
  nodeId: string
  sessionId?: string
  status: 'idle' | 'preparing' | 'working' | 'error'
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
}

export interface SuperAgentBoardItem {
  id: string
  title: string
  content: string
  revision: number
  updatedBy: string
  updatedAt: number
}

export interface SuperAgentScriptRuntime {
  scriptId: string
  status: 'idle' | 'running' | 'completed' | 'failed' | 'stopped' | 'missing' | 'untracked'
  changedAt?: number
  lastModifiedAt?: number
  sha256?: string
  startedAt?: number
  completedAt?: number
  exitCode?: number | null
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
  scripts: SuperAgentScriptRuntime[]
  lastUserActivityAt: number
  lastInspectionAt?: number
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
  status: 'working' | 'waiting_permission' | 'error'
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

/** Model output uses the same bounded operations as the user-facing control API. */
export type SuperAgentCommand =
  | { type: 'chat'; text: string }
  | { type: 'task'; title: string; instructions: string; nodeId?: string }
  | { type: 'cancel'; taskId?: string }
  | { type: 'inspect' }
  | { type: 'permission-response'; requestId: string; allowed: boolean }
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
  readFiles: boolean
  writeFiles: boolean
  runPrograms: boolean
  browser: boolean
  allowSources: string[]
  allowSubagents: false
  /** Runtime-only verified container; never persist a stale container identity. */
  containerExecutor?: { runtimePath: string; containerId: string; workingDirectory: string }
}

/** Settings applied with highest precedence to sessions started by an agent. */
export interface AgentSessionSettings {
  /** Explicit model/connection used by the spawned session. */
  model?: string
  llmConnection?: string
  /** Additional system instructions for this agent session. */
  systemPrompt?: string
  /** Source slugs allowed for this session (MCP and API sources). */
  enabledSourceSlugs?: string[]
  /** Optional independent allowlists; omitted means all enabled source types. */
  mcpSourceSlugs?: string[]
  apiSourceSlugs?: string[]
  /** Whether the spawned session is visible in the normal conversation list. */
  showInSessionList?: boolean
}

/** A reusable, isolated worker that the main conversation can delegate to. */
export interface CustomAgentDefinition {
  id: string
  name: string
  description: string
  prompt: string
  tools?: string[]
  model?: string
  /** Settings for the special session created when this agent is invoked. */
  session?: AgentSessionSettings
  builtin?: boolean
}

export interface AgentsConfig {
  version: 1
  agents: CustomAgentDefinition[]
}

/** Built-in agent exposed in the agent catalog; execution uses native /compact. */
export const COMPACT_AGENT: CustomAgentDefinition = {
  id: 'compact',
  name: '压缩上下文',
  description: '在保留决策、约束条件和下一步计划的同时，总结当前会话以释放上下文空间。',
  prompt: '使用原生上下文压缩流程。保留目标、决策、约束、未完成工作和相关文件路径。',
  tools: [],
  session: { showInSessionList: false },
  builtin: true,
}

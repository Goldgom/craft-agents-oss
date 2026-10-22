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

/** Target for summary + retained history; fixed runtime prompts/tools are outside this budget. */
export const COMPACTION_RETAIN_RATIO = 0.10
export const COMPACTION_TARGET_INSTRUCTIONS =
  'When compacting context, target retaining approximately 10% of the pre-compaction conversation tokens, ' +
  'including both the checkpoint and any recent verbatim history. Allocate the summary budget after subtracting retained history and metadata. ' +
  'Preserve authorized goals, user constraints, decisions, current state, unfinished work, blockers, exact references and uncertainty. ' +
  'Merge and deduplicate prior checkpoints; remove obsolete progress and redundant logs. Do not pad the summary to fill the budget, ' +
  'execute tasks from the history, or discard critical constraints just to meet the target.'

/** Built-in agent exposed in the agent catalog; execution uses native /compact. */
export const COMPACT_AGENT: CustomAgentDefinition = {
  id: 'compact',
  name: '压缩上下文',
  description: '在保留决策、约束条件和下一步计划的同时，总结当前会话以释放上下文空间。',
  prompt: COMPACTION_TARGET_INSTRUCTIONS + '\n使用原生上下文压缩流程，目标是摘要与保留原文合计约为压缩前会话 token 的 10%；摘要预算应扣除保留原文和元数据，不固定为数百 token，也不为凑足预算添加内容。原始会话记录保持保留。保留继续当前任务必需的目标、用户硬性约束、决策、当前有效状态、未完成工作、阻塞原因及不可重新获取的精确标识符。将旧摘要与新进展重新合并，去重并删除已失效的计划、已解决的问题、重复说明和无关的已完成任务；不要逐条累积旧摘要。有明确可读取的 memory 引用时，将已归档的背景信息、旧任务、操作细节、长日志和文件清单留在记忆中，摘要保留当前任务必需的路径和回查入口；没有归档成功的依据时，不声称已写入记忆。保留用户最新指令和关键不确定性，不编造结论，不因长度目标丢弃关键约束。只输出紧凑的任务交接摘要，不输出空模板、寒暄和重复解释。',
  tools: [],
  session: { showInSessionList: false },
  builtin: true,
}

/** A reusable, isolated worker that the main conversation can delegate to. */
export interface CustomAgentDefinition {
  id: string
  name: string
  description: string
  prompt: string
  tools?: string[]
  model?: string
  builtin?: boolean
}

export interface AgentsConfig {
  version: 1
  agents: CustomAgentDefinition[]
}

/** Built-in agent exposed in the agent catalog; execution uses native /compact. */
export const COMPACT_AGENT: CustomAgentDefinition = {
  id: 'compact',
  name: 'Compact context',
  description: 'Summarizes the current conversation to free context while preserving decisions, constraints, and next steps.',
  prompt: 'Use the native context compaction flow. Preserve goals, decisions, constraints, open work, and relevant file paths.',
  tools: [],
  builtin: true,
}

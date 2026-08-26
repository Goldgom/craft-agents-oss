import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { listAgents, loadAgentsConfig, saveAgentsConfig, type CustomAgentDefinition } from '@craft-agent/shared/agents'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [RPC_CHANNELS.agents.LIST, RPC_CHANNELS.agents.SAVE, RPC_CHANNELS.agents.DELETE, RPC_CHANNELS.agents.GENERATE] as const

function workspaceRoot(workspaceId: string): string {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error('Workspace not found')
  return workspace.rootPath
}

export function registerAgentsHandlers(server: RpcServer, _deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.agents.LIST, async (_ctx, workspaceId: string) => listAgents(workspaceRoot(workspaceId)))
  server.handle(RPC_CHANNELS.agents.SAVE, async (_ctx, workspaceId: string, agent: CustomAgentDefinition) => {
    const root = workspaceRoot(workspaceId)
    const current = await loadAgentsConfig(root)
    const storedAgent = agent.id === 'compact'
      ? { ...agent, builtin: true }
      : { ...agent, builtin: undefined }
    const next = current.agents.some(item => item.id === agent.id)
      ? current.agents.map(item => item.id === agent.id ? storedAgent : item)
      : [...current.agents, storedAgent]
    return saveAgentsConfig(root, { version: 1, agents: next })
  })
  server.handle(RPC_CHANNELS.agents.DELETE, async (_ctx, workspaceId: string, agentId: string) => {
    const root = workspaceRoot(workspaceId)
    const current = await loadAgentsConfig(root)
    return saveAgentsConfig(root, { version: 1, agents: current.agents.filter(agent => agent.id !== agentId) })
  })
  // The renderer uses this as a safe AI-assisted starting point. It returns a
  // complete definition that can be reviewed and saved by the user.
  server.handle(RPC_CHANNELS.agents.GENERATE, async (_ctx, _workspaceId: string, request: { name?: string; goal: string }) => {
    const name = request.name?.trim() || 'New agent'
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'custom-agent'
    return {
      id,
      name,
      description: request.goal.trim(),
      prompt: `You are a specialized worker. Complete this goal independently and return a concise, actionable result:\n\n${request.goal.trim()}`,
      tools: ['Read', 'Grep', 'Glob'],
    } satisfies CustomAgentDefinition
  })
}

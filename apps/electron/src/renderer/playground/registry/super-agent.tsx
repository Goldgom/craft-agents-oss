import { useEffect, useState } from 'react'
import type { ComponentEntry } from './types'
import { AppShellProvider, useAppShellContext } from '../../context/AppShellContext'
import SuperAgentPage from '../../pages/super-agent/SuperAgentPage'
import type { LlmConnectionWithStatus, LoadedSource, SessionEvent } from '../../../shared/types'
import type { SuperAgentCommand, SuperAgentConfig, SuperAgentSnapshot } from '@craft-agent/shared/super-agent'

const connection: LlmConnectionWithStatus = {
  slug: 'demo-tokennest', name: 'TokenNest · 演示账户', providerType: 'pi_compat', authType: 'oauth',
  oauthProvider: 'tokennest', createdAt: 1, isAuthenticated: true,
  defaultModel: 'gpt-6-astra', models: ['gpt-6-astra', 'gpt-6-luna'],
  channelGroup: 'demo', channelGroups: [{ id: 'demo', name: '演示分组', models: ['gpt-6-astra', 'gpt-6-luna'] }],
}
const source: LoadedSource = {
  config: { id: 'demo-files', name: '本地资料', slug: 'demo-files', provider: 'local', type: 'local', enabled: true, tagline: '音乐素材与项目笔记' },
  folderPath: 'C:\\Demo\\sources', workspaceRootPath: 'C:\\Demo', workspaceId: 'playground-workspace', guide: null,
}

function demoConfig(): SuperAgentConfig {
  return {
    version: 1, name: '星图助手', avatar: '🪐', idleInspectionMinutes: 15,
    nodes: [
      { id: 'main', role: 'coordinator', name: '星图', avatar: '🪐', description: '和你沟通、协调工作并整理结果。', llmConnection: connection.slug, model: 'gpt-6-astra', thinkingLevel: 'high', maxCallsPerMinute: 6, intelligenceRating: 5, workPreferences: '简洁汇报进展。', sourceSlugs: [], abilityProfileIds: [] },
      { id: 'research', role: 'worker', name: '研究助手', avatar: '🦉', description: '阅读资料，查证信息并整理可追溯的研究笔记。', llmConnection: connection.slug, model: 'gpt-6-astra', thinkingLevel: 'high', maxCallsPerMinute: 6, intelligenceRating: 4, workPreferences: '先核对来源再下结论。', sourceSlugs: [source.config.slug], abilityProfileIds: ['research-profile'] },
      { id: 'executor', role: 'worker', name: '执行助手', avatar: '◈', description: '完成文件整理、结构化记录和脚本任务。', llmConnection: connection.slug, model: 'gpt-6-luna', thinkingLevel: 'medium', maxCallsPerMinute: 12, intelligenceRating: 3, workPreferences: '优先复用项目中的现有文件。', sourceSlugs: [source.config.slug], abilityProfileIds: [] },
    ],
    environment: { kind: 'folder', workingDirectory: 'C:\\Demo\\WorldMusicHub', permissionMode: 'allow-all', permissions: { readFiles: true, writeFiles: true, runPrograms: false, browser: false } },
    sourceSlugs: [source.config.slug],
    abilityProfiles: [{ id: 'research-profile', name: '资料研究', description: '为重要结论保留来源与核查记录。', instructions: '先阅读数据源，再给出结论。使用共享数据板记录发现。' }],
    scripts: [{ id: 'catalog-check', name: '检查音乐目录', path: 'scripts/check_catalog.py', args: ['--verify'], nodeId: 'executor', timeoutSeconds: 120 }],
  }
}

function demoSnapshot(scenario: string): SuperAgentSnapshot {
  const now = Date.now()
  return {
    config: scenario === 'onboarding' ? null : demoConfig(),
    environment: { available: scenario !== 'unavailable', isolation: scenario === 'unavailable' ? 'unavailable' : 'host-folder', detail: scenario === 'unavailable' ? '演示状态：所选 Docker 服务尚未运行。请启动运行时后刷新。' : '演示文件夹权限已配置。' },
    state: {
      version: 1, revision: 1, lastUserActivityAt: now, lastInspectionAt: now - 60_000,
      nodes: [
        { nodeId: 'main', status: scenario === 'activity' ? 'working' : 'idle', sessionId: 'demo-main' },
        { nodeId: 'research', status: 'working', activeTaskId: 'task-research', sessionId: 'demo-research' },
        { nodeId: 'executor', status: scenario === 'activity' ? 'working' : 'idle', sessionId: 'demo-executor' },
      ],
      tasks: [
        { id: 'task-research', title: '整理世界音乐的分类资料', instructions: '研究素材中的地域与风格标签。', nodeId: 'research', sessionId: 'demo-research', status: 'running', createdAt: now - 120_000 },
        { id: 'task-check', title: '核查目录的文件结构', instructions: '检查目录结构并形成报告。', nodeId: 'executor', sessionId: 'demo-executor', status: 'completed', createdAt: now - 240_000, completedAt: now - 60_000, output: '## 演示结果\n\n目录检查已完成。本报告为界面样例，未访问真实文件。' },
      ],
      messages: [
        { id: 'message-user', fromNodeId: 'user', toNodeId: 'main', kind: 'chat', body: '帮我整理音乐素材，先检查目录再总结有哪些音乐风格。', createdAt: now - 180_000 },
        { id: 'message-main', fromNodeId: 'main', toNodeId: 'user', kind: 'chat', body: '我已将工作分给两个节点：\n\n- **执行助手**检查文件结构。\n- **研究助手**整理音乐风格和资料来源。\n\n你可以在工作任务和共享数据板中查看进展。', createdAt: now - 150_000 },
        { id: 'message-task', fromNodeId: 'main', toNodeId: 'research', kind: 'task', taskId: 'task-research', body: '请研究素材的地域与风格标签，记录发现和资料来源。', createdAt: now - 120_000 },
        { id: 'message-result', fromNodeId: 'executor', toNodeId: 'main', kind: 'result', taskId: 'task-check', body: '目录结构已核对，报告已放入共享数据板。', createdAt: now - 60_000 },
      ],
      board: [
        { id: 'board-catalog', title: '目录检查记录', content: '### 演示记录\n\n- 按地区整理素材\n- 保留原始文件名\n- 研究节点正在核查风格标签', revision: 2, updatedBy: 'executor', updatedAt: now - 60_000 },
        { id: 'board-plan', title: '共享工作计划', content: '1. 检查文件结构\n2. 核对音乐标签\n3. 主节点整理总结', revision: 1, updatedBy: 'main', updatedAt: now - 180_000 },
      ],
      scripts: [{ scriptId: 'catalog-check', status: scenario === 'unavailable' ? 'untracked' : 'completed', lastModifiedAt: now - 240_000, completedAt: now - 60_000, exitCode: 0, output: '演示输出：12 个目录结构已检查。未实际运行脚本。', ...(scenario === 'unavailable' ? { error: '演示状态：服务重启后原脚本进程状态未知，请核实后重新登记。' } : {}) }],
    },
    activity: scenario === 'activity' ? [{
      nodeId: 'main', sessionId: 'demo-main', status: 'working', startedAt: now - 3_000, updatedAt: now,
      entries: [
        { id: 'demo-thinking', kind: 'thinking', text: '演示思考摘要：先检查节点提交的结果，再整理音乐风格与来源。', createdAt: now - 3_000, updatedAt: now - 2_000, status: 'completed' },
        { id: 'demo-tool', kind: 'tool', toolName: 'node_status', toolUseId: 'demo-tool-use', text: '演示操作：检查两个工作节点的任务状态。', createdAt: now - 2_000, updatedAt: now - 1_000, status: 'running' },
        { id: 'demo-live-text', kind: 'text', text: '演示动态：', createdAt: now - 1_000, updatedAt: now, status: 'running', turnId: 'demo-live-turn' },
      ],
    }, {
      nodeId: 'research', sessionId: 'demo-research', taskId: 'task-research', status: 'working', startedAt: now - 120_000, updatedAt: now,
      entries: [
        { id: 'demo-worker-thinking', kind: 'thinking', text: '演示思考摘要：按地区检查风格标签，并为结论补充可追溯的来源。', createdAt: now - 2_000, updatedAt: now - 1_000, status: 'completed' },
        { id: 'demo-worker-tool', kind: 'tool', toolName: 'Read', toolUseId: 'demo-worker-read', text: '演示操作：读取 catalog/index.json 中的素材标签。', createdAt: now - 1_000, updatedAt: now, status: 'running' },
      ],
    }, {
      nodeId: 'executor', sessionId: 'demo-executor', status: 'working', startedAt: now - 5_000, updatedAt: now,
      entries: [{ id: 'demo-taskless-text', kind: 'text', text: '演示动态：已收到研究助手的共享消息，正在核对目录记录。', createdAt: now - 1_000, updatedAt: now, status: 'running' }],
    }] : scenario === 'approval' ? [{
      nodeId: 'research', sessionId: 'demo-research', taskId: 'task-research', status: 'waiting_permission', startedAt: now - 120_000, updatedAt: now,
      entries: [{ id: 'demo-waiting', kind: 'status', text: '演示状态：正在等待读取外部资料的授权。', createdAt: now, updatedAt: now }],
    }] : [],
    permissionRequests: scenario === 'approval' ? [{
      id: 'demo-exact-approval', nodeId: 'research', coordinatorId: 'main', sessionId: 'demo-research', taskId: 'task-research',
      toolName: 'Read', description: '演示请求：读取工作目录之外的一份音乐分类参考笔记。', reason: '用于核对素材中的地域与风格标签。',
      scope: { kind: 'file_read', target: 'C:\\Demo\\Reference\\music-notes.md', toolName: 'Read', operation: 'Read music-notes.md', boundary: 'outside-environment', expiresAt: now + 5 * 60_000 },
      status: 'pending', createdAt: now,
    }] : [],
  }
}

/** Demo-only API. No provider calls, file operations, credentials or scripts are used. */
function SuperAgentPreview({ scenario = 'configured' }: { scenario?: 'onboarding' | 'configured' | 'unavailable' | 'activity' | 'approval' }) {
  const shell = useAppShellContext()
  const [ready, setReady] = useState(false)
  const [requests, setRequests] = useState(0)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const api = window.electronAPI
    let snapshot = demoSnapshot(scenario)
    const eventListeners = new Set<(event: SessionEvent) => void>()
    const emit = (event: SessionEvent) => { for (const listener of eventListeners) listener(event) }
    let streamTimer: ReturnType<typeof setInterval> | undefined
    const commit = () => { snapshot.state.revision++; setRequests(value => value + 1); return structuredClone(snapshot) }
    const overrides: Partial<typeof api> = {
      getSuperAgent: async () => structuredClone(snapshot),
      saveSuperAgent: async (_workspaceId, config) => {
        snapshot.config = structuredClone(config)
        snapshot.state.nodes = config.nodes.map(node => ({ nodeId: node.id, status: 'idle', sessionId: 'demo-' + node.id }))
        return commit()
      },
      superAgentCommand: async (_workspaceId, command: SuperAgentCommand) => {
        const now = Date.now()
        if (command.type === 'chat') {
          snapshot.state.messages.push({ id: crypto.randomUUID(), fromNodeId: 'user', toNodeId: snapshot.config!.nodes[0].id, kind: 'chat', body: command.text, createdAt: now })
          snapshot.state.messages.push({ id: crypto.randomUUID(), fromNodeId: snapshot.config!.nodes[0].id, toNodeId: 'user', kind: 'chat', body: '演示响应：已收到你的目标。这里没有实际调用 AI。', createdAt: now + 1 })
        }
        if (command.type === 'task') snapshot.state.tasks.push({ id: crypto.randomUUID(), title: command.title, instructions: command.instructions, nodeId: command.nodeId ?? snapshot.config!.nodes.find(node => node.role === 'worker')!.id, status: 'queued', createdAt: now })
        if (command.type === 'cancel') {
          for (const task of snapshot.state.tasks) if ((!command.taskId || task.id === command.taskId) && ['queued', 'running'].includes(task.status)) task.status = 'cancelled'
          snapshot.activity = snapshot.activity?.filter(item => command.taskId && item.taskId !== command.taskId)
          for (const node of snapshot.state.nodes) if (!command.taskId || node.activeTaskId === command.taskId) { node.status = 'idle'; node.activeTaskId = undefined }
          if (!command.taskId && streamTimer !== undefined) clearInterval(streamTimer)
        }
        if (command.type === 'permission-response') {
          const request = snapshot.permissionRequests?.find(item => item.id === command.requestId)
          if (!request || request.status !== 'pending') throw new Error('演示请求已处理，请刷新。')
          request.status = command.allowed ? 'approved' : 'denied'; request.resolvedAt = now
          snapshot.activity = snapshot.activity?.filter(item => item.nodeId !== request.nodeId)
          snapshot.state.messages.push({ id: crypto.randomUUID(), fromNodeId: request.coordinatorId, toNodeId: 'user', kind: 'chat', body: command.allowed ? '演示响应：已授权研究助手在本轮读取所示资料。未实际访问文件。' : '演示响应：已拒绝这次读取请求。', createdAt: now })
          emit({ type: 'permission_resolved', sessionId: request.sessionId, requestId: request.id, allowed: command.allowed })
        }
        if (command.type === 'message') snapshot.state.messages.push({ id: crypto.randomUUID(), fromNodeId: command.fromNodeId, toNodeId: command.toNodeId, kind: 'message', body: command.body, createdAt: now })
        if (command.type === 'board-upsert') {
          const current = snapshot.state.board.find(item => item.id === command.item.id)
          if (current && current.revision !== command.expectedRevision) throw new Error('演示版本冲突：请关闭后重新打开内容。')
          const item = { id: command.item.id ?? crypto.randomUUID(), title: command.item.title, content: command.item.content, revision: (current?.revision ?? 0) + 1, updatedBy: 'user', updatedAt: now }
          snapshot.state.board = [...snapshot.state.board.filter(value => value.id !== item.id), item]
        }
        if (command.type === 'board-delete') snapshot.state.board = snapshot.state.board.filter(item => item.id !== command.id)
        if (command.type === 'inspect') snapshot.state.messages.push({ id: crypto.randomUUID(), fromNodeId: snapshot.config!.nodes[0].id, toNodeId: 'user', kind: 'inspection', body: '演示检查：所有工作状态仅为界面样例。', createdAt: now })
        if (command.type === 'script-run' || command.type === 'script-stop') throw new Error('此演示不运行脚本。')
        return commit()
      },
      getSources: async () => [source],
      getSkills: async () => [],
      onSessionEvent: listener => { eventListeners.add(listener); return () => { eventListeners.delete(listener) } },
      refreshLlmConnectionModels: async () => ({ success: true }),
      openFolderDialog: async () => 'C:\\Demo\\WorldMusicHub',
    }
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, api[key as keyof typeof api]]))
    Object.assign(api, overrides); setRequests(0); setNotice(''); setReady(true)
    if (scenario === 'activity') {
      const chunks = ['目录核查已完成。', '研究助手正在整理地域和风格标签。', '\n\n我会在资料核查完成后', '为你汇总结果与来源。']
      let step = 0
      streamTimer = setInterval(() => {
        const activity = snapshot.activity?.find(item => item.nodeId === 'main')
        const entry = activity?.entries.find(item => item.id === 'demo-live-text')
        if (!activity || !entry) { clearInterval(streamTimer); return }
        const now = Date.now()
        const chunk = chunks[step++]
        if (chunk) {
          entry.text += chunk; entry.updatedAt = now; activity.updatedAt = now
          emit({ type: 'text_delta', sessionId: activity.sessionId, delta: chunk, turnId: entry.turnId })
          return
        }
        const tool = activity.entries.find(item => item.id === 'demo-tool')!
        tool.status = 'completed'; tool.updatedAt = now; tool.text = '演示结果：执行助手已完成目录检查；研究助手仍在核查资料。'
        entry.status = 'completed'; entry.updatedAt = now
        snapshot.state.messages.push({ id: crypto.randomUUID(), fromNodeId: 'main', toNodeId: 'user', kind: 'chat', body: entry.text, createdAt: now })
        snapshot.state.nodes.find(node => node.nodeId === 'main')!.status = 'idle'
        snapshot.activity = snapshot.activity?.filter(item => item.nodeId !== 'main')
        emit({ type: 'text_complete', sessionId: activity.sessionId, text: entry.text, turnId: entry.turnId })
        emit({ type: 'complete', sessionId: activity.sessionId })
        clearInterval(streamTimer)
      }, 650)
    }
    return () => { if (streamTimer !== undefined) clearInterval(streamTimer); eventListeners.clear(); Object.assign(api, previous); setReady(false) }
  }, [scenario])
  return <AppShellProvider value={{ ...shell, llmConnections: [connection], workspaceDefaultLlmConnection: connection.slug, pendingPermissions: new Map(), isCompactMode: false }}>
    <div className="flex h-full min-h-0 flex-col"><div className="shrink-0 border-b border-amber-500/20 bg-amber-500/8 px-4 py-2 text-[10px] text-amber-700 dark:text-amber-400">Synthetic preview · 不调用 AI、不操作文件、不运行脚本 · 操作记录 {requests}{notice && ' · ' + notice}</div>
      <div className="min-h-0 flex-1">{ready && <SuperAgentPage key={scenario} onOpenAiSettings={() => setNotice('演示：打开 AI 设置')} onOpenSession={id => setNotice('演示会话：' + id)} />}</div></div>
  </AppShellProvider>
}

export const superAgentComponents: ComponentEntry[] = [{
  id: 'super-agent', name: 'Super Agent', category: 'Agent Setup',
  description: 'Synthetic onboarding, streamed activity and scoped approvals. Production uses real server APIs.',
  component: SuperAgentPreview, layout: 'full',
  props: [{ name: 'scenario', control: { type: 'select', options: [
    { label: 'Configured team', value: 'configured' }, { label: 'Live activity', value: 'activity' }, { label: 'Approval in chat', value: 'approval' }, { label: 'First-use setup', value: 'onboarding' }, { label: 'Unavailable environment', value: 'unavailable' },
  ] }, defaultValue: 'configured' }],
  variants: [
    { name: 'Configured team', props: { scenario: 'configured' } },
    { name: 'Live activity', props: { scenario: 'activity' } },
    { name: 'Approval in chat', props: { scenario: 'approval' } },
    { name: 'First-use setup', props: { scenario: 'onboarding' } },
    { name: 'Unavailable environment', props: { scenario: 'unavailable' } },
  ],
}]

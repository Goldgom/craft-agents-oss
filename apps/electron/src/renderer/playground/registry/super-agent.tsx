import { useEffect, useState } from 'react'
import type { ComponentEntry } from './types'
import { AppShellProvider, useAppShellContext } from '../../context/AppShellContext'
import SuperAgentPage from '../../pages/super-agent/SuperAgentPage'
import type { LlmConnectionWithStatus, LoadedSource } from '../../../shared/types'
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
    environment: { kind: 'folder', workingDirectory: 'C:\\Demo\\WorldMusicHub', permissionMode: 'ask', permissions: { readFiles: true, writeFiles: true, runPrograms: false, browser: false } },
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
        { nodeId: 'main', status: 'idle', sessionId: 'demo-main' },
        { nodeId: 'research', status: 'working', activeTaskId: 'task-research', sessionId: 'demo-research' },
        { nodeId: 'executor', status: 'idle', sessionId: 'demo-executor' },
      ],
      tasks: [
        { id: 'task-research', title: '整理世界音乐的分类资料', instructions: '研究素材中的地域与风格标签。', nodeId: 'research', status: 'running', createdAt: now - 120_000 },
        { id: 'task-check', title: '核查目录的文件结构', instructions: '检查目录结构并形成报告。', nodeId: 'executor', status: 'completed', createdAt: now - 240_000, completedAt: now - 60_000, output: '## 演示结果\n\n目录检查已完成。本报告为界面样例，未访问真实文件。' },
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
  }
}

/** Demo-only API. No provider calls, file operations, credentials or scripts are used. */
function SuperAgentPreview({ scenario = 'configured' }: { scenario?: 'onboarding' | 'configured' | 'unavailable' }) {
  const shell = useAppShellContext()
  const [ready, setReady] = useState(false)
  const [requests, setRequests] = useState(0)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const api = window.electronAPI
    let snapshot = demoSnapshot(scenario)
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
        if (command.type === 'cancel') for (const task of snapshot.state.tasks) if ((!command.taskId || task.id === command.taskId) && ['queued', 'running'].includes(task.status)) task.status = 'cancelled'
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
      refreshLlmConnectionModels: async () => ({ success: true }),
      openFolderDialog: async () => 'C:\\Demo\\WorldMusicHub',
    }
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, api[key as keyof typeof api]]))
    Object.assign(api, overrides); setRequests(0); setNotice(''); setReady(true)
    return () => { Object.assign(api, previous); setReady(false) }
  }, [scenario])
  return <AppShellProvider value={{ ...shell, llmConnections: [connection], workspaceDefaultLlmConnection: connection.slug, isCompactMode: false }}>
    <div className="flex h-full min-h-0 flex-col"><div className="shrink-0 border-b border-amber-500/20 bg-amber-500/8 px-4 py-2 text-[10px] text-amber-700 dark:text-amber-400">Synthetic preview · 不调用 AI、不操作文件、不运行脚本 · 操作记录 {requests}{notice && ' · ' + notice}</div>
      <div className="min-h-0 flex-1">{ready && <SuperAgentPage key={scenario} onOpenAiSettings={() => setNotice('演示：打开 AI 设置')} onOpenSession={id => setNotice('演示会话：' + id)} />}</div></div>
  </AppShellProvider>
}

export const superAgentComponents: ComponentEntry[] = [{
  id: 'super-agent', name: 'Super Agent', category: 'Agent Setup',
  description: 'Synthetic onboarding and configured workspace. Production uses real server APIs.',
  component: SuperAgentPreview, layout: 'full',
  props: [{ name: 'scenario', control: { type: 'select', options: [
    { label: 'Configured team', value: 'configured' }, { label: 'First-use setup', value: 'onboarding' }, { label: 'Unavailable environment', value: 'unavailable' },
  ] }, defaultValue: 'configured' }],
  variants: [
    { name: 'Configured team', props: { scenario: 'configured' } },
    { name: 'First-use setup', props: { scenario: 'onboarding' } },
    { name: 'Unavailable environment', props: { scenario: 'unavailable' } },
  ],
}]

import { useState, type ReactNode } from 'react'
import { Plus, Trash2, WandSparkles } from 'lucide-react'
import type { SuperAgentModelEntry } from '@tokenbird/shared/super-agent'
import { THINKING_LEVEL_IDS } from '@tokenbird/shared/agent/thinking-levels'
import { getCompatibleAgentRuntimes } from '@tokenbird/shared/config/llm-connections'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { nodeModels } from './super-agent-ui'
import { createSubagentModelPreset, mergeSubagentModelPresets, tokenNestModelPresets } from './super-agent-model-presets'

type Text = (zh: string, en: string) => string
const selectClass = 'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs'
function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1"><span className="text-xs font-medium">{label}</span>{children}<span className="text-[10px] leading-4 text-muted-foreground">{hint}</span></label>
}

export function SuperAgentModelPool({ entries, connections, onChange, tr, chinese }: {
  entries: SuperAgentModelEntry[]; connections: LlmConnectionWithStatus[]; onChange: (entries: SuperAgentModelEntry[]) => void; tr: Text; chinese: boolean
}) {
  const [presetConnection, setPresetConnection] = useState('')
  const [notice, setNotice] = useState('')
  const tokenNestConnections = connections.filter(item => item.isAuthenticated && item.oauthProvider === 'tokennest')
  const selected = tokenNestConnections.find(item => item.slug === presetConnection) ?? tokenNestConnections[0]
  const presets = selected ? tokenNestModelPresets(selected, nodeModels(selected), chinese) : []
  function update(id: string, change: Partial<SuperAgentModelEntry>) { onChange(entries.map(entry => entry.id === id ? { ...entry, ...change } : entry)) }
  return <div className="space-y-3">
    <div className="space-y-2 rounded-lg bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {tokenNestConnections.length > 1 && <select aria-label={tr('TokenNest 预设连接', 'TokenNest preset connection')} className={`${selectClass} max-w-52`} value={selected?.slug ?? ''} onChange={event => setPresetConnection(event.target.value)}>{tokenNestConnections.map(item => <option key={item.slug} value={item.slug}>{item.name}</option>)}</select>}
        <Button size="sm" variant="outline" disabled={!presets.length || entries.length >= 100} onClick={() => {
          const result = mergeSubagentModelPresets(entries, presets)
          onChange(result.entries)
          setNotice(tr(`已补充 ${result.added} 个模型，已有配置保持不变。${result.skipped ? `另有 ${result.skipped} 个超出 100 条上限。` : ''}`, `Added ${result.added} models; existing settings were preserved.${result.skipped ? ` ${result.skipped} exceeded the 100-entry limit.` : ''}`))
        }}><WandSparkles className="size-3.5" />{tr('补齐 TokenNest 模型预设', 'Add TokenNest model presets')}{selected && ` (${presets.length})`}</Button>
        <span className="text-[11px] text-muted-foreground">{tr(`已启用 ${entries.filter(entry => entry.enabled).length} / ${entries.length} 个模型`, `${entries.filter(entry => entry.enabled).length} / ${entries.length} models enabled`)}</span>
      </div>
      <p className="text-[11px] leading-4 text-muted-foreground">{selected
        ? tr(`从 ${selected.name} 当前渠道分组的可用文本模型补齐，不覆盖已有设置。预设能力与分数是可修改的选型建议，不是官方基准成绩。`, `Adds available text models from ${selected.name}'s current channel group without overwriting existing settings. Notes and scores are editable selection advice, not official benchmarks.`)
        : tr('登录 TokenNest 后，可一键配置当前账户可用的模型。', 'Sign in to TokenNest to configure the models available to your account.')}</p>
      {notice && <p role="status" className="text-xs text-primary">{notice}</p>}
    </div>
    {entries.map(entry => {
      const connection = connections.find(item => item.slug === entry.llmConnection)
      const models = nodeModels(connection)
      return <article key={entry.id} aria-label={entry.name} className="space-y-3 rounded-lg border border-border p-3">
        <div className="flex items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 text-xs" title={tr('勾选后，后台可为新任务选择此模型。', 'Allow the background node to choose this model for new tasks.')}><input type="checkbox" checked={entry.enabled} onChange={event => update(entry.id, { enabled: event.target.checked })} /><span className="truncate font-medium">{entry.name}</span><span className="shrink-0 text-muted-foreground">{tr('允许使用', 'Enabled')}</span></label>
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={tr(`删除模型 ${entry.name}`, `Remove model ${entry.name}`)} onClick={() => onChange(entries.filter(item => item.id !== entry.id))}><Trash2 className="size-3.5" /></Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_7rem]">
          <Field label={tr('模型连接', 'Connection')} hint={tr('决定服务、认证和渠道分组。', 'Selects service, authentication and channel group.')}><select className={selectClass} value={entry.llmConnection} onChange={event => {
            const next = connections.find(item => item.slug === event.target.value), available = nodeModels(next)
            update(entry.id, { llmConnection: event.target.value, model: next?.defaultModel && available.includes(next.defaultModel) ? next.defaultModel : available[0] ?? '', agentRuntime: undefined })
          }}><option value="" disabled>{tr('选择连接', 'Select connection')}</option>{entry.llmConnection && !connections.some(item => item.isAuthenticated && item.slug === entry.llmConnection) && <option value={entry.llmConnection}>{connection?.name ?? entry.llmConnection}</option>}{connections.filter(item => item.isAuthenticated).map(item => <option key={item.slug} value={item.slug}>{item.name}</option>)}</select></Field>
          <Field label={tr('模型', 'Model')} hint={tr('后台为任务实际调用的模型。', 'The model called for each assigned task.')}>{models.length ? <select className={selectClass} value={entry.model} onChange={event => update(entry.id, { model: event.target.value })}>{!models.includes(entry.model) && <option value={entry.model}>{entry.model || '—'}</option>}{models.map(model => <option key={model} value={model}>{model}</option>)}</select> : <Input className="h-8 text-xs" value={entry.model} onChange={event => update(entry.id, { model: event.target.value })} />}</Field>
          <Field label={tr('智能等级 / 100', 'Intelligence / 100')} hint={tr('相对选型分数，可自行调整。', 'Editable relative selection score.')}><Input className="h-8 text-xs" type="number" min={0} max={100} step={1} value={entry.intelligenceScore} onChange={event => update(entry.id, { intelligenceScore: Number(event.target.value) })} /></Field>
        </div>
        <Field label={tr('能力说明', 'Capability notes')} hint={tr('统一填写擅长领域、标签、局限与评价，供后台选型；不是任务或岗位指令。', 'Combine strengths, tags, limitations and evaluations for model selection; this is not a task or role instruction.')}><textarea className="min-h-16 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring" rows={2} maxLength={16000} value={entry.capabilityNotes} onChange={event => update(entry.id, { capabilityNotes: event.target.value })} /></Field>
        <details className="group text-xs">
          <summary className="cursor-pointer text-muted-foreground">{tr('高级设置 · 显示名称、执行后端、调用频率、思考范围', 'Advanced · display name, runtime, call rate, thinking levels')}</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label={tr('显示名称', 'Display name')} hint={tr('用于在模型池中辨认此配置。', 'Identifies this configuration in the model pool.')}><Input className="h-8 text-xs" value={entry.name} onChange={event => update(entry.id, { name: event.target.value })} /></Field>
            <Field label={tr('执行后端', 'Runtime')} hint={tr('默认沿用连接的执行方式。', 'Uses the connection runtime by default.')}><select className={selectClass} value={entry.agentRuntime ?? ''} onChange={event => update(entry.id, { agentRuntime: (event.target.value || undefined) as SuperAgentModelEntry['agentRuntime'] })}><option value="">{tr('跟随连接', 'Follow connection')}</option>{connection && getCompatibleAgentRuntimes(connection).map(runtime => <option key={runtime} value={runtime}>{runtime}</option>)}</select></Field>
            <Field label={tr('工作轮次 / 分钟', 'Turns / minute')} hint={tr('限制单个 subagent 的工作轮次启动频率。', 'Limits turn starts for each individual subagent.')}><Input className="h-8 text-xs" type="number" min={0.1} max={60} step={0.1} value={entry.maxCallsPerMinute} onChange={event => update(entry.id, { maxCallsPerMinute: Number(event.target.value) })} /></Field>
            <div className="space-y-1.5 sm:col-span-3"><p className="text-xs font-medium">{tr('允许的思考强度', 'Allowed thinking levels')}</p><div className="flex flex-wrap gap-x-4 gap-y-2">{THINKING_LEVEL_IDS.map(level => <label key={level} className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={entry.supportedThinkingLevels.includes(level)} onChange={event => update(entry.id, { supportedThinkingLevels: event.target.checked ? [...entry.supportedThinkingLevels, level] : entry.supportedThinkingLevels.filter(item => item !== level) })} />{level}</label>)}</div><p className="text-[10px] leading-4 text-muted-foreground">{tr('限定后台可选范围，不固定每次调用的强度；最终能力受模型和后端支持限制。', 'Sets the range the background node can choose, without fixing effort per call. Actual support depends on the model and runtime.')}</p></div>
          </div>
        </details>
      </article>
    })}
    <Button size="sm" variant="outline" disabled={entries.length >= 100} onClick={() => {
      const connection = connections.find(item => item.isAuthenticated && nodeModels(item).length)
      const models = nodeModels(connection), model = connection?.defaultModel && models.includes(connection.defaultModel) ? connection.defaultModel : models[0] ?? ''
      onChange([...entries, createSubagentModelPreset(connection?.slug ?? '', model, chinese)])
    }}><Plus className="size-3.5" />{tr('手动添加模型', 'Add model manually')}</Button>
  </div>
}

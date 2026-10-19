import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle } from 'lucide-react'
import { rebuildSuperAgentConfig, validateSuperAgentConfig, type SuperAgentConfig, type SuperAgentNode } from '@tokenbird/shared/super-agent'
import { THINKING_LEVEL_IDS } from '@tokenbird/shared/agent/thinking-levels'
import { getCompatibleAgentRuntimes } from '@tokenbird/shared/config/llm-connections'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AvatarEditor, EnvironmentEditor, FormField, FormSection } from './SuperAgentForms'
import { SuperAgentModelPool } from './SuperAgentModelPool'
import { createDynamicConfig, nodeModels, useSuperAgentText } from './super-agent-ui'

const selectClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm'
type ModelParameters = Pick<SuperAgentNode, 'llmConnection' | 'model' | 'agentRuntime' | 'maxCallsPerMinute'>

function ModelFields({ value, connections, onChange, tr }: {
  value: ModelParameters; connections: LlmConnectionWithStatus[]; onChange: (change: Partial<ModelParameters>) => void; tr: (zh: string, en: string) => string
}) {
  const connection = connections.find(item => item.slug === value.llmConnection)
  const models = nodeModels(connection)
  return <div className="grid gap-4 sm:grid-cols-2">
    <FormField label={tr('连接', 'Connection')}><select className={selectClass} value={value.llmConnection} onChange={event => {
      const selected = connections.find(item => item.slug === event.target.value), available = nodeModels(selected)
      onChange({ llmConnection: event.target.value, model: selected?.defaultModel && available.includes(selected.defaultModel) ? selected.defaultModel : available[0] ?? '', agentRuntime: undefined })
    }}><option value="" disabled>{tr('选择连接', 'Select connection')}</option>{connections.filter(item => item.isAuthenticated).map(item => <option key={item.slug} value={item.slug}>{item.name}</option>)}</select></FormField>
    <FormField label={tr('模型', 'Model')}>{models.length ? <select className={selectClass} value={value.model} onChange={event => onChange({ model: event.target.value })}>
      {!models.includes(value.model) && <option value={value.model}>{value.model || '—'}</option>}{models.map(model => <option key={model} value={model}>{model}</option>)}
    </select> : <Input value={value.model} onChange={event => onChange({ model: event.target.value })} />}</FormField>
    <FormField label={tr('执行后端', 'Runtime')}><select className={selectClass} value={value.agentRuntime ?? ''} onChange={event => onChange({ agentRuntime: (event.target.value || undefined) as ModelParameters['agentRuntime'] })}>
      <option value="">{tr('跟随连接', 'Follow connection')}</option>{connection && getCompatibleAgentRuntimes(connection).map(runtime => <option key={runtime} value={runtime}>{runtime}</option>)}
    </select></FormField>
    <FormField label={tr('每分钟调用上限', 'Calls per minute')}><Input type="number" min={0.1} max={60} step={0.1} value={value.maxCallsPerMinute} onChange={event => onChange({ maxCallsPerMinute: Number(event.target.value) })} /></FormField>
  </div>
}

export function SuperAgentRebuildSettings({ config, connections, defaultConnection, onSave, onOpenAiSettings, onReset }: {
  config?: SuperAgentConfig; connections: LlmConnectionWithStatus[]; defaultConnection?: string
  onSave: (config: SuperAgentConfig) => Promise<void>; onOpenAiSettings?: () => void; onReset?: () => Promise<void>
}) {
  const { i18n } = useTranslation(), text = useSuperAgentText()
  const tr = (zh: string, en: string) => i18n.language.startsWith('zh') ? zh : en
  const [draft, setDraft] = useState(() => config ? rebuildSuperAgentConfig(structuredClone(config)) : createDynamicConfig(connections, text, defaultConnection))
  const [step, setStep] = useState(0)
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false)
  const patch = (change: Partial<SuperAgentConfig>) => { setDraft(value => ({ ...value, ...change })); setSaved(false) }
  const steps = [tr('主节点', 'Main node'), tr('后台节点', 'Background node'), tr('subagent 可用模型', 'Available subagent models')]
  const node = draft.nodes.find(item => item.role === (step === 0 ? 'coordinator' : 'orchestrator'))
  const updateNode = (change: Partial<SuperAgentNode>) => { if (node) patch({ nodes: draft.nodes.map(item => item.id === node.id ? { ...item, ...change } : item) }) }
  async function save() {
    setPending(true); setError(''); setSaved(false)
    try { await onSave(validateSuperAgentConfig(draft)); setSaved(true) } catch (error) { setError(error instanceof Error ? error.message : String(error)) } finally { setPending(false) }
  }
  function next() {
    if (!node?.name.trim() || !node.llmConnection || !node.model.trim()) { setError(tr('请填写节点名称并选择模型连接和模型。', 'Enter a node name and select its connection and model.')); return }
    setError(''); setStep(value => Math.min(2, value + 1))
  }
  return <div className="h-full overflow-y-auto"><div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-5">
    <div className="flex items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">{config ? tr('超级智能体配置', 'Super Agent configuration') : tr('创建超级智能体', 'Create Super Agent')}</h2><p className="mt-1 text-xs text-muted-foreground">{tr('主节点负责用户交互，后台节点负责规划协调；每项任务独立创建 subagent。', 'The main node handles conversation, the background node plans and coordinates, and each task gets an independent subagent.')}</p></div>{onOpenAiSettings && <Button variant="outline" onClick={onOpenAiSettings}>{tr('模型连接', 'AI connections')}</Button>}</div>
    <nav aria-label={tr('配置步骤', 'Configuration steps')} className="flex flex-wrap gap-2">{steps.map((label, index) => <Button key={label} variant={step === index ? 'default' : 'outline'} aria-current={step === index ? 'step' : undefined} disabled={pending || (!config && index > step)} onClick={() => { setStep(index); setError('') }}>{index + 1}. {label}</Button>)}</nav>
    <fieldset disabled={pending} className="min-w-0 space-y-4">
      {step === 0 && <FormSection title={tr('基本设置', 'General')}>
        <AvatarEditor avatar={draft.avatar} name={draft.name} onChange={avatar => patch({ avatar })} />
        <FormField label={tr('超级智能体名称', 'Super Agent name')}><Input value={draft.name} onChange={event => patch({ name: event.target.value })} /></FormField>
        <FormField label={tr('汇报检查间隔（秒）', 'Report check interval (seconds)')} hint={tr('仅有新增汇报时唤醒主节点。', 'Wakes the main node only when new reports exist.')}><Input type="number" min={1} max={3600} value={draft.reportCheckSeconds ?? 5} onChange={event => patch({ reportCheckSeconds: Number(event.target.value) })} /></FormField>
      </FormSection>}
      {step < 2 && node && <FormSection title={steps[step]} description={step === 0 ? tr('负责用户交互、理解需求和转述汇报。', 'Handles conversation, requirements and reports.') : tr('负责规划、协调、按任务选择模型并启动独立 subagent。', 'Plans, coordinates, selects a model and launches an independent subagent per task.')}>
        <FormField label={tr('节点名称', 'Node name')}><Input value={node.name} onChange={event => updateNode({ name: event.target.value })} /></FormField>
        <ModelFields value={node} connections={connections} onChange={updateNode} tr={tr} />
        <FormField label={tr('思考强度', 'Thinking effort')}><select className={selectClass} value={node.thinkingLevel} onChange={event => updateNode({ thinkingLevel: event.target.value as SuperAgentNode['thinkingLevel'] })}>{THINKING_LEVEL_IDS.map(level => <option key={level} value={level}>{level}</option>)}</select></FormField>
      </FormSection>}
      {step === 1 && <EnvironmentEditor environment={draft.environment} onChange={environment => patch({ environment })} />}
      {step === 2 && <FormSection title={steps[2]}>
        <p className="text-xs text-muted-foreground">{tr('这里只配置 AI 模型的基本参数和能力，不预设 agent 岗位或工作。后台在每次派工时给出任务，并决定本次思考强度；同一模型可以启动多个独立 subagent。', 'Configure AI model parameters and capabilities, without agent roles or jobs. The background node supplies each task and its thinking effort; one model can power multiple independent subagents.')}</p>
        <FormField label={tr('最大同时执行 subagent 数量', 'Maximum concurrent subagents')} hint={tr('与模型条目数量无关，不包含主节点和后台节点。调低上限后，已有任务继续执行。', 'Independent of model count; excludes the main and background nodes. Existing runs finish when the limit is lowered.')}><Input type="number" min={1} max={30} value={draft.maxConcurrentSubagents ?? 4} onChange={event => patch({ maxConcurrentSubagents: Number(event.target.value) })} /></FormField>
        <SuperAgentModelPool entries={draft.modelPool ?? []} connections={connections} onChange={modelPool => patch({ modelPool })} tr={tr} chinese={i18n.language.startsWith('zh')} />
      </FormSection>}
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex items-center justify-end gap-3">
      {saved && <span role="status" className="text-sm text-emerald-600">{tr('已保存', 'Saved')}</span>}
      {step > 0 && <Button variant="outline" disabled={pending} onClick={() => { setStep(value => value - 1); setError('') }}>{tr('上一步', 'Back')}</Button>}
      {step < 2 && <Button disabled={pending} onClick={next}>{tr('下一步', 'Next')}</Button>}
      {(config || step === 2) && <Button disabled={pending} onClick={() => void save()}>{pending && <LoaderCircle className="size-4 animate-spin" />}{config ? tr('保存配置', 'Save configuration') : tr('创建超级智能体', 'Create Super Agent')}</Button>}
    </div>
    {onReset && <Button variant="destructive" disabled={pending} onClick={() => { if (window.confirm(tr('清除超级智能体配置和运行数据？独立资源库将保留。', 'Clear Super Agent configuration and runtime data? Its resource library will be retained.'))) void onReset().catch(error => setError(String(error))) }}>{tr('重置超级智能体', 'Reset Super Agent')}</Button>}
  </div></div>
}

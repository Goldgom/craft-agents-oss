import { SuperAgentSelect } from './SuperAgentSelect'
import { useTranslation } from 'react-i18next'
import type { SuperAgentConfig } from '@tokenbird/shared/super-agent'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { FormField, FormSection } from './SuperAgentForms'
import { nodeModels } from './super-agent-ui'

export function SuperAgentCompactionSettings({ config, connections, onChange }: {
  config: SuperAgentConfig; connections: LlmConnectionWithStatus[]
  onChange: (value: NonNullable<SuperAgentConfig['contextCompaction']>) => void
}) {
  const { i18n } = useTranslation()
  const tr = (zh: string, en: string) => i18n.language.startsWith('zh') ? zh : en
  const value = { enabled: true, tokenThreshold: 252000, saveToMemory: true, ...config.contextCompaction }
  const slugs = new Set([...config.nodes.filter(node => !node.dynamic).map(node => node.llmConnection), ...(config.modelPool ?? []).filter(entry => entry.enabled).map(entry => entry.llmConnection), ...Object.keys(value.models ?? {})])
  return <FormSection title={tr('上下文压缩', 'Context compaction')}>
    <div className="flex items-center justify-between gap-4"><label htmlFor="team-compaction-enabled">{tr('自动压缩', 'Automatic compaction')}</label><Switch id="team-compaction-enabled" checked={value.enabled} onCheckedChange={enabled => onChange({ ...value, enabled })} /></div>
    <FormField label={tr('触发阈值（token）', 'Trigger threshold (tokens)')}><Input type="number" min={8000} max={2000000} step={1000} disabled={!value.enabled} value={value.tokenThreshold} onChange={event => onChange({ ...value, tokenThreshold: Number(event.target.value) })} /></FormField>
    <div className="flex items-center justify-between gap-4"><label htmlFor="team-compaction-memory">{tr('保存压缩记忆', 'Save compaction memory')}</label><Switch id="team-compaction-memory" checked={value.saveToMemory} onCheckedChange={saveToMemory => onChange({ ...value, saveToMemory })} /></div>
    <p className="text-xs leading-5 text-muted-foreground">{tr('为每个连接单独指定压缩模型。Pi 后端使用此预设；原生 Codex、Claude 后端使用各自的压缩机制。', 'Choose a separate compression model for each connection. Pi uses these presets; native Codex and Claude use their own compaction mechanisms.')}</p>
    {[...slugs].map(slug => {
      const connection = connections.find(item => item.slug === slug)
      const models = nodeModels(connection)
      const selected = value.models?.[slug] ?? ''
      return <FormField key={slug} label={`${connection?.name ?? slug} · ${tr('压缩模型', 'Compression model')}`}>
        <SuperAgentSelect className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={selected} onChange={event => {
          const models = { ...value.models }
          if (event.target.value) models[slug] = event.target.value
          else delete models[slug]
          onChange({ ...value, models })
        }}>
          <option value="">{tr('跟随连接压缩设置', 'Use connection compaction settings')}</option>
          {selected && !models.includes(selected) && <option value={selected}>{selected}</option>}
          {models.map(model => <option key={model} value={model}>{model}</option>)}
        </SuperAgentSelect>
      </FormField>
    })}
  </FormSection>
}

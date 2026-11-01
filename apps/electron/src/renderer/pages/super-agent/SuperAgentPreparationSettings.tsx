import { useTranslation } from 'react-i18next'
import type { SuperAgentConfig } from '@tokenbird/shared/super-agent'
import { Input } from '@/components/ui/input'
import { FormField, FormSection } from './SuperAgentForms'

export function SuperAgentPreparationSettings({ config, onChange }: {
  config: SuperAgentConfig
  onChange: (execution: NonNullable<SuperAgentConfig['execution']>) => void
}) {
  const { i18n } = useTranslation()
  const tr = (zh: string, en: string) => i18n.language.startsWith('zh') ? zh : en
  const fields = [
    { key: 'preparationTimeoutSeconds', initial: 120, min: 10, max: 600, label: tr('文件夹 / 虚拟机准备超时（秒）', 'Folder / VM preparation timeout (seconds)') },
    { key: 'sandboxPreparationTimeoutSeconds', initial: 600, min: 30, max: 3600, label: tr('容器准备超时（秒）', 'Container preparation timeout (seconds)') },
    { key: 'preparationMaxRetries', initial: 2, min: 0, max: 2, label: tr('准备失败自动重试次数', 'Automatic preparation retries') },
  ] as const
  return <FormSection title={tr('准备阶段恢复', 'Preparation recovery')}>
    <p className="text-xs leading-5 text-muted-foreground">{tr('超时后取消本次准备，保留任务与执行证据。旧操作和运行时清理结束后才可重试；结果未知或重试耗尽时停止自动恢复。', 'Timeout cancels preparation and preserves tasks and evidence. Retry waits for the old operation and runtime cleanup. Unknown outcomes or an exhausted retry budget stop automatic recovery.')}</p>
    {fields.map(field => <FormField key={field.key} label={field.label}><Input type="number" min={field.min} max={field.max} step={1}
      value={config.execution?.[field.key] ?? field.initial}
      onChange={event => onChange({ connectionConcurrency: 30, connectionCallsPerMinute: 600, stallMinutes: 15, maxResumeAttempts: 3, ...config.execution, [field.key]: Number(event.target.value) })} /></FormField>)}
  </FormSection>
}

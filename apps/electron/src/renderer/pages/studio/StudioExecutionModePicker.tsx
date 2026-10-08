import { useTranslation } from 'react-i18next'
import { WorkbenchSelect } from '@/components/ui/workbench-select'
import { Zap } from 'lucide-react'

export type StudioExecutionMode = 'execute' | 'ask'

export function studioExecutionMode(value: unknown): StudioExecutionMode {
  return value === 'ask' ? 'ask' : 'execute'
}

export function StudioExecutionModePicker({ value, onChange }: { value: StudioExecutionMode; onChange: (mode: StudioExecutionMode) => void }) {
  const { t } = useTranslation()
  return <label className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
    <Zap className="size-3.5" />
    <span className="sr-only">{t('studio.executionMode')}</span>
    <WorkbenchSelect className="h-7 w-auto max-w-32 bg-transparent px-2" aria-label={t('studio.executionMode')} value={value} onValueChange={value => onChange(studioExecutionMode(value))} options={[{ value: "execute", label: t('studio.execute') }, { value: "ask", label: t('studio.ask') }]} />
  </label>
}

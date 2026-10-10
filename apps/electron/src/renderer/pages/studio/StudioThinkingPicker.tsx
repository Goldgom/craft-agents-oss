import { WorkbenchSelect } from '@/components/ui/workbench-select'
import { BrainCircuit } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { THINKING_LEVELS, isValidThinkingLevel, type ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'

export type StudioThinkingLevel = ThinkingLevel | 'auto'

export function studioThinkingLevel(value: unknown): StudioThinkingLevel {
  return value === 'auto' || isValidThinkingLevel(value) ? value : 'auto'
}

export function StudioThinkingPicker({ value, onChange }: { value: StudioThinkingLevel; onChange: (value: StudioThinkingLevel) => void }) {
  const { t } = useTranslation()
  return <label className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground" title={t('studio.thinkingHint')}>
    <BrainCircuit className="size-3.5 shrink-0" />
    <span className="sr-only">{t('studio.thinkingLevel')}</span>
    <WorkbenchSelect className="h-7 w-auto max-w-32 bg-transparent px-2" aria-label={t('studio.thinkingLevel')} value={value} onValueChange={value => onChange(studioThinkingLevel(value))} options={[{ value: "auto", label: t('studio.automatic') }, ...THINKING_LEVELS.map(level => ({ value: level.id, label: t(level.nameKey) }))]} />
  </label>
}

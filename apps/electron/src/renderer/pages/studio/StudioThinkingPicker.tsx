import { BrainCircuit } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { THINKING_LEVELS, isValidThinkingLevel, type ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'

export type StudioThinkingLevel = ThinkingLevel | 'auto'

export function studioThinkingLevel(value: unknown): StudioThinkingLevel {
  return value === 'auto' || isValidThinkingLevel(value) ? value : 'auto'
}

export function StudioThinkingPicker({ value, onChange }: { value: StudioThinkingLevel; onChange: (value: StudioThinkingLevel) => void }) {
  const { t } = useTranslation()
  return <label className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground" title="思考强度由所选模型和连接决定是否支持">
    <BrainCircuit className="size-3.5 shrink-0" />
    <span className="sr-only">思考强度</span>
    <select className="h-7 max-w-20 cursor-pointer rounded-md bg-transparent px-1 text-xs text-foreground outline-none hover:bg-accent" aria-label="思考强度" value={value} onChange={event => onChange(studioThinkingLevel(event.target.value))}>
      <option value="auto">自动</option>
      {THINKING_LEVELS.map(level => <option key={level.id} value={level.id}>{t(level.nameKey)}</option>)}
    </select>
  </label>
}

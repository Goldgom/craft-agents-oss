import { WorkbenchSelect } from '@/components/ui/workbench-select'
import { Check, Settings2, Sparkles } from 'lucide-react'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { SUPER_AGENT_PRESETS, type SuperAgentPreset } from './super-agent-presets'
import { nodeModels, type SuperAgentText } from './super-agent-ui'

export function SuperAgentPresetPicker({ connections, connectionSlug, onConnectionChange, preset, onChoose, text }: {
  connections: LlmConnectionWithStatus[]
  connectionSlug: string
  onConnectionChange: (slug: string) => void
  preset: SuperAgentPreset
  onChoose: (preset: SuperAgentPreset) => void
  text: SuperAgentText
}) {
  const ready = connections.filter(item => item.isAuthenticated && nodeModels(item).length)
  const available = ready.some(item => item.slug === connectionSlug)
  return <section className="space-y-3">
    <h2 className="text-sm font-semibold">{text('preset')}</h2>
    <p className="text-xs leading-5 text-muted-foreground">{text(available ? 'presetDescription' : 'presetUnavailable')}</p>
    {ready.length > 0 && <label className="flex flex-wrap items-center gap-3 text-xs">
      {text('selectConnection')}
      <WorkbenchSelect className="max-w-full" value={connectionSlug} onValueChange={value => onConnectionChange(value)} options={[...ready.map(item => ({ value: item.slug, label: item.name }))]} />
    </label>}
    <div className="grid gap-3 sm:grid-cols-2">
      {[...SUPER_AGENT_PRESETS, 'custom' as const].map(value => {
        const key = value as SuperAgentPreset
        return <button key={key} type="button" disabled={key !== 'custom' && !available} onClick={() => onChoose(key)} aria-pressed={preset === key}
          className={cn('flex items-start gap-3 rounded-xl border p-4 text-left transition-colors disabled:opacity-50', preset === key ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50')}>
          <span className="mt-0.5 text-primary">{key === 'custom' ? <Settings2 className="size-4" /> : <Sparkles className="size-4" />}</span>
          <span className="min-w-0 flex-1"><span className="text-sm font-medium">{text(key)}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{text(`${key}Description`)}</span></span>
          {preset === key && <Check className="mt-1 size-4 shrink-0 text-primary" />}
        </button>
      })}
    </div>
  </section>
}

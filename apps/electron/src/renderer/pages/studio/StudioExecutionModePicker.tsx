import { Zap } from 'lucide-react'

export type StudioExecutionMode = 'execute' | 'ask'

export function studioExecutionMode(value: unknown): StudioExecutionMode {
  return value === 'ask' ? 'ask' : 'execute'
}

export function StudioExecutionModePicker({ value, onChange }: { value: StudioExecutionMode; onChange: (mode: StudioExecutionMode) => void }) {
  return <label className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
    <Zap className="size-3.5" />
    <span className="sr-only">操作模式</span>
    <select className="h-7 cursor-pointer rounded-md bg-transparent px-1 text-xs text-foreground outline-none hover:bg-accent" aria-label="操作模式" value={value} onChange={event => onChange(studioExecutionMode(event.target.value))}>
      <option value="execute">执行</option>
      <option value="ask">询问</option>
    </select>
  </label>
}

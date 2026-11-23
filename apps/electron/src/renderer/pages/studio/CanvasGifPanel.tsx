import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WorkbenchSelect } from '@/components/ui/workbench-select'

export function CanvasGifPanel({ hasSelection, onCommand, onSave }: {
  hasSelection: boolean
  onCommand: (input: Record<string, unknown>) => Promise<unknown>
  onSave: (data: string, name: string) => void
}) {
  const { t } = useTranslation()
  const [gifMode, setMode] = useState('zoom'), [frameDelay, setDelay] = useState(100)
  const [repeat, setRepeat] = useState(0), [maxSize, setSize] = useState(512)
  const [running, setRunning] = useState(false), [preview, setPreview] = useState('')
  const label = (key: string) => t(`studio.gif.${key}`)
  const field = 'w-full rounded-md border border-border bg-background px-2 py-1 text-xs'
  return <fieldset disabled={running} className="space-y-2">
    <p className="text-sm font-semibold">{label('title')}</p>
    <p className="text-xs text-muted-foreground">{label('hint')}</p>
    <WorkbenchSelect value={gifMode} onValueChange={setMode} options={['zoom', 'layers'].map(value => ({ value, label: label(value) }))} />
    <div className="grid grid-cols-2 gap-2">
      <label className="text-xs">{label('delay')}<input className={field} type="number" min={20} max={2000} step={10} value={frameDelay} onChange={event => setDelay(Number(event.target.value))} /></label>
      <label className="text-xs">{label('size')}<input className={field} type="number" min={16} max={1024} value={maxSize} onChange={event => setSize(Number(event.target.value))} /></label>
    </div>
    <label className="block text-xs">{label('repeat')}<input className={field} type="number" min={-1} max={100} value={repeat} onChange={event => setRepeat(Number(event.target.value))} /></label>
    <button className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs hover:bg-accent disabled:opacity-40" disabled={!hasSelection || running} onClick={async () => {
      setRunning(true); setPreview('')
      try {
        const result = await onCommand({ action: 'generate_gif', gifMode, frameDelay, repeat, maxSize }) as { base64: string; mime: string }
        const url = `data:${result.mime};base64,${result.base64}`
        setPreview(url); onSave(url, 'tokenbird-selection.gif')
      } catch { /* The canvas command boundary presents the error. */ }
      finally { setRunning(false) }
    }}>{label(running ? 'working' : 'generate')}</button>
    {!hasSelection && <p className="text-xs text-muted-foreground">{label('selectFirst')}</p>}
    {preview && <img src={preview} alt={label('preview')} className="max-h-48 max-w-full rounded border border-border" />}
  </fieldset>
}

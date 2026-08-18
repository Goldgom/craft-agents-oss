import * as React from 'react'
import { toast } from 'sonner'
import { Check, Clock3, Code2, Cpu, Play, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { LlmConnectionWithStatus } from '@craft-agent/shared/config/llm-connections'
import type { PermissionMode } from '../../../shared/types'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import type { AutomationListItem, PromptAction } from './types'

type IntervalUnit = 'seconds' | 'minutes' | 'hours'

interface AutomationConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  automation: AutomationListItem
  workspaceId: string
  connections: LlmConnectionWithStatus[]
}

const fieldClass = 'space-y-1.5'

export function AutomationConfigDialog({ open, onOpenChange, automation, workspaceId, connections }: AutomationConfigDialogProps) {
  const firstPrompt = automation.actions.find((action): action is PromptAction => action.type === 'prompt')
  const [name, setName] = React.useState(automation.name)
  const [enabled, setEnabled] = React.useState(automation.enabled)
  const [cron, setCron] = React.useState(automation.cron ?? '0 9 * * *')
  const [timezone, setTimezone] = React.useState(automation.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [provider, setProvider] = React.useState(firstPrompt?.llmConnection ?? firstPrompt?.provider ?? automation.provider ?? '')
  const [model, setModel] = React.useState(firstPrompt?.model ?? '')
  const [mode, setMode] = React.useState<PermissionMode>(automation.permissionMode ?? firstPrompt?.mode ?? 'safe')
  const [thinking, setThinking] = React.useState<ThinkingLevel>(firstPrompt?.thinkingLevel ?? 'medium')
  const [prompt, setPrompt] = React.useState(firstPrompt?.prompt ?? '')
  const [script, setScript] = React.useState(automation.script ?? 'return false')
  const initialSeconds = Math.max(1, Math.round((automation.intervalMs ?? 60_000) / 1000))
  const [intervalValue, setIntervalValue] = React.useState(String(initialSeconds >= 3600 && initialSeconds % 3600 === 0 ? initialSeconds / 3600 : initialSeconds >= 60 && initialSeconds % 60 === 0 ? initialSeconds / 60 : initialSeconds))
  const [intervalUnit, setIntervalUnit] = React.useState<IntervalUnit>(initialSeconds >= 3600 && initialSeconds % 3600 === 0 ? 'hours' : initialSeconds >= 60 && initialSeconds % 60 === 0 ? 'minutes' : 'seconds')
  const [timeout, setTimeoutValue] = React.useState(String(automation.scriptTimeoutMs ?? 2000))
  const [metadata, setMetadata] = React.useState(JSON.stringify(automation.scriptMetadata ?? {}, null, 2))
  const [saving, setSaving] = React.useState(false)
  const isHosted = automation.event === 'HostedScriptTick'
  const selectedConnection = connections.find(connection => connection.slug === provider)
  const models = (selectedConnection?.models ?? []).map(item => typeof item === 'string' ? item : item.id)

  React.useEffect(() => {
    if (!open) return
    const nextPrompt = automation.actions.find((action): action is PromptAction => action.type === 'prompt')
    const nextSeconds = Math.max(1, Math.round((automation.intervalMs ?? 60_000) / 1000))
    const nextUnit: IntervalUnit = nextSeconds >= 3600 && nextSeconds % 3600 === 0 ? 'hours' : nextSeconds >= 60 && nextSeconds % 60 === 0 ? 'minutes' : 'seconds'
    setName(automation.name)
    setEnabled(automation.enabled)
    setCron(automation.cron ?? '0 9 * * *')
    setTimezone(automation.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
    setProvider(nextPrompt?.llmConnection ?? nextPrompt?.provider ?? automation.provider ?? '')
    setModel(nextPrompt?.model ?? '')
    setMode(automation.permissionMode ?? nextPrompt?.mode ?? 'safe')
    setThinking(nextPrompt?.thinkingLevel ?? 'medium')
    setPrompt(nextPrompt?.prompt ?? '')
    setScript(automation.script ?? 'return false')
    setIntervalUnit(nextUnit)
    setIntervalValue(String(nextUnit === 'hours' ? nextSeconds / 3600 : nextUnit === 'minutes' ? nextSeconds / 60 : nextSeconds))
    setTimeoutValue(String(automation.scriptTimeoutMs ?? 2000))
    setMetadata(JSON.stringify(automation.scriptMetadata ?? {}, null, 2))
  }, [open, automation])

  const save = async () => {
    let parsedMetadata: Record<string, unknown> | undefined
    try {
      const parsed = metadata.trim() ? JSON.parse(metadata) : {}
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Metadata must be a JSON object')
      parsedMetadata = parsed
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Invalid metadata JSON')
      return
    }
    const unitMs = intervalUnit === 'hours' ? 3_600_000 : intervalUnit === 'minutes' ? 60_000 : 1000
    const intervalMs = Math.round(Number(intervalValue) * unitMs)
    if (isHosted && (!Number.isFinite(intervalMs) || intervalMs < 1000)) {
      toast.error('Interval must be at least one second')
      return
    }
    if (!isHosted && cron.trim().split(/\s+/).length !== 5) {
      toast.error('Cron expression must contain five fields')
      return
    }
    if (isHosted && !script.trim()) {
      toast.error('Script cannot be empty')
      return
    }
    const actions = automation.actions.map(action => action === firstPrompt ? {
      ...action,
      prompt: prompt.trim(),
      llmConnection: provider || undefined,
      provider: undefined,
      model: model.trim() || undefined,
      thinkingLevel: thinking,
      mode: undefined,
    } : action)
    setSaving(true)
    try {
      await window.electronAPI.updateAutomation(workspaceId, automation.event, automation.matcherIndex, {
        id: automation.id,
        name: name.trim() || automation.name,
        enabled: enabled ? undefined : false,
        matcher: automation.matcher,
        cron: isHosted ? undefined : cron.trim(),
        timezone: timezone.trim() || undefined,
        permissionMode: mode,
        provider: provider || undefined,
        labels: automation.labels,
        conditions: automation.conditions,
        telegramTopic: automation.telegramTopic,
        script: isHosted ? script : undefined,
        intervalMs: isHosted ? intervalMs : undefined,
        scriptTimeoutMs: isHosted ? Math.max(10, Math.min(30_000, Number(timeout) || 2000)) : undefined,
        scriptMetadata: isHosted ? parsedMetadata : undefined,
        actions,
      })
      toast.success('Automation saved')
      onOpenChange(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save automation'
      if (message.includes('No handler for: automations:update')) {
        toast.error('The connected server does not support automation updates. Update and restart the server, then try again.')
      } else {
        toast.error(message)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-[720px]">
        <DialogHeader className="border-b border-foreground/10 px-6 py-5">
          <DialogTitle className="flex items-center gap-2 text-base">
            {isHosted ? <Code2 className="size-4" /> : <Clock3 className="size-4" />}
            {isHosted ? 'Hosted script' : 'Scheduled automation'}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 space-y-6 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-1 items-end gap-4 sm:grid-cols-[1fr_auto]">
            <div className={fieldClass}>
              <Label htmlFor="automation-name">Name</Label>
              <Input id="automation-name" value={name} onChange={event => setName(event.target.value)} />
            </div>
            <div className="flex h-9 items-center gap-2 px-1">
              <Switch checked={enabled} onCheckedChange={setEnabled} id="automation-enabled" />
              <Label htmlFor="automation-enabled">Active</Label>
            </div>
          </div>

          {isHosted ? (
            <section className="space-y-4 border-t border-foreground/10 pt-5">
              <div className="flex items-center gap-2 text-sm font-medium"><Play className="size-4 text-foreground/60" /> Trigger</div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_140px_160px]">
                <div className={fieldClass}>
                  <Label>Run every</Label>
                  <Input type="number" min="1" value={intervalValue} onChange={event => setIntervalValue(event.target.value)} />
                </div>
                <div className={fieldClass}>
                  <Label>Unit</Label>
                  <Select value={intervalUnit} onValueChange={value => setIntervalUnit(value as IntervalUnit)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent className="z-floating-menu">{['seconds', 'minutes', 'hours'].map(unit => <SelectItem key={unit} value={unit}>{unit}</SelectItem>)}</SelectContent></Select>
                </div>
                <div className={fieldClass}>
                  <Label>Timeout (ms)</Label>
                  <Input type="number" min="10" max="30000" value={timeout} onChange={event => setTimeoutValue(event.target.value)} />
                </div>
              </div>
              <div className={fieldClass}>
                <Label htmlFor="hosted-script">Script</Label>
                <Textarea id="hosted-script" value={script} onChange={event => setScript(event.target.value)} className="min-h-48 resize-y font-mono text-xs leading-5" spellCheck={false} />
              </div>
              <div className={fieldClass}>
                <Label htmlFor="script-metadata">Attached metadata</Label>
                <Textarea id="script-metadata" value={metadata} onChange={event => setMetadata(event.target.value)} className="min-h-24 resize-y font-mono text-xs leading-5" spellCheck={false} />
              </div>
            </section>
          ) : (
            <section className="space-y-4 border-t border-foreground/10 pt-5">
              <div className="flex items-center gap-2 text-sm font-medium"><Clock3 className="size-4 text-foreground/60" /> Schedule</div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className={fieldClass}><Label>Cron expression</Label><Input value={cron} onChange={event => setCron(event.target.value)} className="font-mono" /></div>
                <div className={fieldClass}><Label>Timezone</Label><Input value={timezone} onChange={event => setTimezone(event.target.value)} /></div>
              </div>
            </section>
          )}

          {firstPrompt && (
            <section className="space-y-4 border-t border-foreground/10 pt-5">
              <div className="flex items-center gap-2 text-sm font-medium"><Cpu className="size-4 text-foreground/60" /> Runtime</div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className={fieldClass}>
                  <Label>Provider</Label>
                  <Select value={provider || '__default'} onValueChange={value => { setProvider(value === '__default' ? '' : value); setModel('') }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent className="z-floating-menu"><SelectItem value="__default">Workspace default</SelectItem>{connections.map(connection => <SelectItem key={connection.slug} value={connection.slug}>{connection.name}</SelectItem>)}</SelectContent></Select>
                </div>
                <div className={fieldClass}>
                  <Label>Model</Label>
                  {models.length ? <Select value={model || '__default'} onValueChange={value => setModel(value === '__default' ? '' : value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent className="z-floating-menu"><SelectItem value="__default">Provider default</SelectItem>{models.map(id => <SelectItem key={id} value={id}>{id}</SelectItem>)}</SelectContent></Select> : <Input value={model} onChange={event => setModel(event.target.value)} placeholder="Provider default" />}
                </div>
                <div className={fieldClass}>
                  <Label>Run mode</Label>
                  <Select value={mode} onValueChange={value => setMode(value as PermissionMode)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent className="z-floating-menu"><SelectItem value="safe">Explore</SelectItem><SelectItem value="ask">Ask</SelectItem><SelectItem value="allow-all">Execute</SelectItem></SelectContent></Select>
                </div>
                <div className={fieldClass}>
                  <Label>Thinking</Label>
                  <Select value={thinking} onValueChange={value => setThinking(value as ThinkingLevel)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent className="z-floating-menu">{['off', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => <SelectItem key={level} value={level}>{level}</SelectItem>)}</SelectContent></Select>
                </div>
              </div>
              <div className={fieldClass}><Label>Prompt</Label><Textarea value={prompt} onChange={event => setPrompt(event.target.value)} className="min-h-28 resize-y" /></div>
            </section>
          )}
        </div>

        <DialogFooter className="border-t border-foreground/10 px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || (firstPrompt ? !prompt.trim() : false)}>
            {saving ? <Check className="size-4" /> : <Save className="size-4" />}
            {saving ? 'Saved' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

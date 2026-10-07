import { useEffect, useState } from 'react'
import { Check, LoaderCircle, Plus, Settings2, Sparkles } from 'lucide-react'
import type { SuperAgentConfig, SuperAgentEnvironmentStatus } from '@craft-agent/shared/super-agent'
import type { LlmConnectionWithStatus, LoadedSource } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { AgentAvatar, AvatarEditor, EnvironmentEditor, FormField, FormSection, NodeEditor } from './SuperAgentForms'
import { applyPreset, configError, createNode, nodeModels, useSuperAgentText, withExecuteMode, type SuperAgentPreset } from './super-agent-ui'
import { SuperAgentPresetPicker } from './SuperAgentPresetPicker'

export function SuperAgentConfiguration({ config, connections, sources, environmentStatus, onSave, onContinuousWork, onOpenAiSettings, initialNodeId }: {
  config: SuperAgentConfig
  connections: LlmConnectionWithStatus[]
  sources: LoadedSource[]
  environmentStatus: SuperAgentEnvironmentStatus
  onSave: (config: SuperAgentConfig) => Promise<void>
  onContinuousWork: (enabled: boolean) => Promise<void>
  onOpenAiSettings?: () => void
  initialNodeId?: string
}) {
  const text = useSuperAgentText()
  const [draft, setDraft] = useState(() => withExecuteMode(structuredClone(config)))
  const [selectedNodeId, setSelectedNodeId] = useState(initialNodeId ?? config.nodes[0].id)
  const [section, setSection] = useState<'identity' | 'team' | 'environment'>(initialNodeId ? 'team' : 'identity')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [preset, setPreset] = useState<SuperAgentPreset>('custom')
  const [presetConnectionSlug, setPresetConnectionSlug] = useState(config.nodes[0].llmConnection)
  // The page header can change this live setting while the rest of the form is unsaved.
  useEffect(() => {
    setDraft(current => ({ ...current, continuousWork: config.continuousWork }))
  }, [config.continuousWork])
  const presetConnection = connections.find(item => item.slug === presetConnectionSlug && item.isAuthenticated && nodeModels(item).length)
    ?? connections.find(item => item.isAuthenticated && nodeModels(item).length)
  const selected = draft.nodes.find(node => node.id === selectedNodeId) ?? draft.nodes[0]
  const patch = (updates: Partial<SuperAgentConfig>) => { setDraft(current => ({ ...current, ...updates })); setSaved(false) }
  async function save() {
    const validation = configError(draft, connections, text)
    if (validation) { setError(validation); return }
    setPending(true); setError('')
    try { await onSave(draft); setSaved(true) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setPending(false) }
  }
  async function toggleContinuousWork(enabled: boolean) {
    setPending(true); setError('')
    try { await onContinuousWork(enabled); patch({ continuousWork: enabled }) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setPending(false) }
  }
  return <div className="h-full min-h-0 overflow-y-auto">
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-semibold">{text('settings')}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{text('unsaved')}</p></div>
        {onOpenAiSettings && <Button variant="outline" size="sm" onClick={onOpenAiSettings}><Settings2 className="size-3.5" />{text('manageConnections')}</Button>}
      </div>
      <div className="flex gap-1 rounded-lg bg-foreground/5 p-1">{(['identity', 'team', 'environment'] as const).map(key => <button type="button" key={key} onClick={() => setSection(key)}
        className={cn('flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors', section === key ? 'bg-background shadow-xs' : 'text-muted-foreground hover:text-foreground')}>{text(key)}</button>)}</div>
      <fieldset disabled={pending} className="min-w-0 space-y-5">
        {section === 'identity' && <FormSection title={text('identity')}>
          <AvatarEditor avatar={draft.avatar} name={draft.name} onChange={avatar => patch({ avatar })} />
          <FormField label={text('assistantName')}><Input value={draft.name} maxLength={80} onChange={event => patch({ name: event.target.value })} /></FormField>
          <div className="flex items-start justify-between gap-4"><div><label htmlFor="continuous-work-setting" className="text-sm font-medium">{text('continuousWork')}</label><p id="continuous-work-setting-hint" className="mt-1 text-xs leading-5 text-muted-foreground">{text('continuousWorkHint')}</p></div>
            <Switch id="continuous-work-setting" type="button" checked={draft.continuousWork === true} aria-describedby="continuous-work-setting-hint" onCheckedChange={enabled => void toggleContinuousWork(enabled)} /></div>
          <FormField label={text('idleInterval')} hint={text('idleHint')}><Input type="number" min={1} max={1440} step={1} className="max-w-44" value={draft.idleInspectionMinutes} onChange={event => patch({ idleInspectionMinutes: Number(event.target.value) })} /></FormField>
        </FormSection>}
        {section === 'team' && <>
          <SuperAgentPresetPicker connections={connections} connectionSlug={presetConnection?.slug ?? ''}
            onConnectionChange={slug => { setPresetConnectionSlug(slug); setPreset('custom') }}
            preset={preset} onChoose={value => {
              setPreset(value)
              if (presetConnection && value !== 'custom') {
                const next = applyPreset(draft, value, presetConnection, text)
                setDraft(next); setSelectedNodeId(next.nodes[0].id); setSaved(false)
              }
            }} text={text} />
          <p className="text-xs leading-5 text-muted-foreground">{text('presetReplaceHint')}</p>
          <p className="rounded-lg bg-primary/5 p-3 text-xs leading-5 text-muted-foreground">{text('coordinatorRule')}</p>
          <div className="flex flex-wrap gap-2">
            {draft.nodes.map(node => <button key={node.id} type="button" onClick={() => setSelectedNodeId(node.id)}
              className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors', selected.id === node.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent')}>
              <AgentAvatar avatar={node.avatar} name={node.name} className="size-6 rounded-md text-sm" /><span className="max-w-36 truncate">{node.name}</span>
              {node.role === 'coordinator' && <Sparkles className="size-3 text-primary" />}
            </button>)}
            <Button type="button" variant="outline" size="sm" onClick={() => {
              const node = createNode('worker', connections, text)
              patch({ nodes: [...draft.nodes, node] }); setSelectedNodeId(node.id)
            }}><Plus className="size-3.5" />{text('addWorker')}</Button>
          </div>
          <FormSection title={text('editNode')}>
            <NodeEditor node={selected} connections={connections} sources={sources.filter(source => draft.sourceSlugs.includes(source.config.slug))} abilities={draft.abilityProfiles}
              onChange={node => patch({ nodes: draft.nodes.map(item => item.id === node.id ? node : item) })}
              onRemove={selected.role === 'worker' && draft.nodes.filter(node => node.role === 'worker').length > 1
                ? () => { patch({ nodes: draft.nodes.filter(node => node.id !== selected.id), scripts: draft.scripts.map(script => script.nodeId === selected.id ? { ...script, nodeId: undefined } : script) }); setSelectedNodeId(draft.nodes[0].id) } : undefined} />
          </FormSection>
        </>}
        {section === 'environment' && <EnvironmentEditor environment={draft.environment} status={environmentStatus} onChange={environment => patch({ environment })} />}
      </fieldset>
      {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <div className="flex items-center justify-end gap-3 border-t border-border/70 pt-5">
        {saved && <span role="status" className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400"><Check className="size-3.5" />{text('completed')}</span>}
        <Button disabled={pending} onClick={() => void save()}>{pending ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}{text('save')}</Button>
      </div>
    </div>
  </div>
}

import { useEffect, useState } from 'react'
import { BookOpen, Check, Code2, Database, FileCode2, LoaderCircle, Pencil, Play, Plus, Square, Trash2 } from 'lucide-react'
import type { SuperAgentAbilityProfile, SuperAgentCommand, SuperAgentConfig, SuperAgentScript, SuperAgentSnapshot } from '@craft-agent/shared/super-agent'
import type { LoadedSkill, LoadedSource } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ChoiceList, FormField, FormSection, selectClass, textareaClass } from './SuperAgentForms'
import { formatTimestamp, useSuperAgentText } from './super-agent-ui'

export function SuperAgentResources({ config, sources, skills, onSave }: {
  config: SuperAgentConfig
  sources: LoadedSource[]
  skills: LoadedSkill[]
  onSave: (config: SuperAgentConfig) => Promise<void>
}) {
  const text = useSuperAgentText()
  const [sourceSlugs, setSourceSlugs] = useState(config.sourceSlugs)
  const [ability, setAbility] = useState<SuperAgentAbilityProfile | null>(null)
  const [assignedNodeIds, setAssignedNodeIds] = useState<string[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const sourceKey = config.sourceSlugs.join('|')
  useEffect(() => setSourceSlugs(config.sourceSlugs), [sourceKey])
  async function save(next: SuperAgentConfig, after?: () => void) {
    setPending(true); setError('')
    try { await onSave(next); after?.() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setPending(false) }
  }
  function editAbility(profile?: SuperAgentAbilityProfile) {
    const next = profile ? { ...profile } : { id: crypto.randomUUID(), name: '', description: '', instructions: '' }
    setAbility(next); setAssignedNodeIds(config.nodes.filter(node => node.abilityProfileIds.includes(next.id)).map(node => node.id)); setError('')
  }
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-3xl space-y-6 p-6">
    <FormSection title={text('sources')} description={text('sourcesHint')}>
      {sources.length > 0 ? <ChoiceList items={sources.map(source => ({ id: source.config.slug, name: source.config.name, description: source.config.tagline ?? source.config.provider }))}
        selected={sourceSlugs} onChange={setSourceSlugs} /> : <EmptyResource icon={Database} message={text('noSources')} />}
      {sources.length > 0 && <div className="flex justify-end"><Button size="sm" disabled={pending || sourceKey === sourceSlugs.join('|')} onClick={() => void save({
        ...config, sourceSlugs,
        nodes: config.nodes.map(node => ({ ...node, sourceSlugs: node.sourceSlugs.filter(slug => sourceSlugs.includes(slug)) })),
      })}>{pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}{text('save')}</Button></div>}
    </FormSection>
    <section className="space-y-4 rounded-xl border border-border/70 bg-background p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">{text('abilities')}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{text('abilityHint')}</p></div>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => editAbility()}><Plus className="size-3.5" />{text('addAbility')}</Button></div>
      {config.abilityProfiles.length === 0 ? <EmptyResource icon={BookOpen} message={text('noAbilities')} /> : <div className="space-y-3">
        {config.abilityProfiles.map(profile => <div key={profile.id} className="rounded-lg border border-border/60 p-4">
          <div className="flex items-start gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary"><BookOpen className="size-4" /></span>
            <div className="min-w-0 flex-1"><h4 className="text-sm font-medium">{profile.name}</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">{profile.description}</p></div>
            <Button size="icon" variant="ghost" className="size-7" aria-label={text('edit')} disabled={pending} onClick={() => editAbility(profile)}><Pencil className="size-3.5" /></Button>
            <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" aria-label={text('delete')} disabled={pending} onClick={() => void save({
              ...config, abilityProfiles: config.abilityProfiles.filter(item => item.id !== profile.id),
              nodes: config.nodes.map(node => ({ ...node, abilityProfileIds: node.abilityProfileIds.filter(id => id !== profile.id) })),
            })}><Trash2 className="size-3.5" /></Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">{config.nodes.filter(node => node.abilityProfileIds.includes(profile.id)).map(node => <span key={node.id} className="rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] text-muted-foreground">{node.name}</span>)}</div>
        </div>)}
      </div>}
    </section>
    {skills.length > 0 && <FormSection title={text('workspaceSkills')}>
      <div className="max-h-80 space-y-2 overflow-y-auto">
        {skills.map(skill => <div key={skill.slug + skill.path} className="flex items-center gap-3 rounded-lg border border-border/60 p-3">
          <div className="min-w-0 flex-1"><p className="text-sm font-medium">{skill.metadata.name}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{skill.metadata.description}</p></div>
          <Button variant="outline" size="sm" disabled={pending || config.abilityProfiles.some(profile => profile.name === skill.metadata.name)} onClick={() => {
            const profile = { id: crypto.randomUUID(), name: skill.metadata.name, description: skill.metadata.description, instructions: skill.content }
            void save({ ...config, abilityProfiles: [...config.abilityProfiles, profile] })
          }}>{text('importSkill')}</Button>
        </div>)}
      </div>
    </FormSection>}
    {error && !ability && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    <Dialog open={ability !== null} onOpenChange={open => { if (!open && !pending) setAbility(null) }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{text('abilities')}</DialogTitle><DialogDescription>{text('abilityHint')}</DialogDescription></DialogHeader>
        {ability && <fieldset disabled={pending} className="min-w-0 space-y-4">
          <FormField label={text('abilityName')}><Input value={ability.name} maxLength={80} onChange={event => setAbility({ ...ability, name: event.target.value })} /></FormField>
          <FormField label={text('description')}><Input value={ability.description} onChange={event => setAbility({ ...ability, description: event.target.value })} /></FormField>
          <FormField label={text('instructions')}><textarea rows={7} className={textareaClass} value={ability.instructions} onChange={event => setAbility({ ...ability, instructions: event.target.value })} /></FormField>
          <div className="space-y-2"><h3 className="text-sm font-medium">{text('team')}</h3><ChoiceList items={config.nodes.map(node => ({ id: node.id, name: node.name }))} selected={assignedNodeIds} onChange={setAssignedNodeIds} /></div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button variant="outline" type="button" onClick={() => setAbility(null)}>{text('cancel')}</Button>
            <Button type="button" disabled={!ability.name.trim() || !ability.instructions.trim()} onClick={() => void save({
              ...config, abilityProfiles: [...config.abilityProfiles.filter(profile => profile.id !== ability.id), { ...ability, name: ability.name.trim() }],
              nodes: config.nodes.map(node => ({ ...node, abilityProfileIds: [...node.abilityProfileIds.filter(id => id !== ability.id), ...(assignedNodeIds.includes(node.id) ? [ability.id] : [])] })),
            }, () => setAbility(null))}>{pending && <LoaderCircle className="size-3.5 animate-spin" />}{text('save')}</Button>
          </DialogFooter>
        </fieldset>}
      </DialogContent>
    </Dialog>
  </div></div>
}

export function SuperAgentScripts({ snapshot, onSave, onCommand }: {
  snapshot: SuperAgentSnapshot & { config: SuperAgentConfig }
  onSave: (config: SuperAgentConfig) => Promise<void>
  onCommand: (command: SuperAgentCommand) => Promise<void>
}) {
  const text = useSuperAgentText()
  const { config, state } = snapshot
  const [script, setScript] = useState<SuperAgentScript | null>(null)
  const [argsText, setArgsText] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const hostScriptGranted = config.environment.kind !== 'folder'
    || Object.values(config.environment.permissions).every(Boolean)
  const canRun = snapshot.environment.available && config.environment.permissions.runPrograms && hostScriptGranted
  async function run(action: () => Promise<void>, after?: () => void) {
    setPending(true); setError('')
    try { await action(); after?.() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setPending(false) }
  }
  function editScript(value?: SuperAgentScript) {
    setScript(value ? { ...value } : { id: crypto.randomUUID(), name: '', path: '', args: [], timeoutSeconds: 120 })
    setArgsText(value?.args.join('\n') ?? ''); setError('')
  }
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-3xl space-y-5 p-6">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{text('scripts')}</h2><p className="mt-1 max-w-lg text-xs leading-5 text-muted-foreground">{text('scriptHint')}</p></div>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => editScript()}><Plus className="size-3.5" />{text('addScript')}</Button></div>
    {config.environment.kind === 'folder' && <p className="rounded-lg bg-foreground/5 p-3 text-xs leading-5 text-muted-foreground">{text('hostScriptPermissions')}</p>}
    {config.environment.kind !== 'folder' && !config.environment.permissions.runPrograms
      && <p className="rounded-lg bg-foreground/5 p-3 text-xs leading-5 text-muted-foreground">{text('manualScriptPermissions')}</p>}
    {config.scripts.length === 0 ? <div className="rounded-xl border border-border/70 p-8"><EmptyResource icon={Code2} message={text('noScripts')} /></div>
      : config.scripts.map(item => {
        const runtime = state.scripts.find(value => value.scriptId === item.id)
        const active = runtime?.status === 'running'
        return <section key={item.id} className="space-y-4 rounded-xl border border-border/70 p-5">
          <div className="flex items-start gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary"><FileCode2 className="size-5" /></span>
            <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{item.name}</h3><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{item.path}</p></div>
            <span className="rounded-full bg-foreground/5 px-2 py-1 text-[11px] text-muted-foreground">{text(runtime?.status ?? 'idle')}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              {runtime?.lastModifiedAt && <span>{text('changedAt')}: {formatTimestamp(runtime.lastModifiedAt)}</span>}
              {runtime?.exitCode !== undefined && runtime.exitCode !== null && <span>{text('exitCode')}: {runtime.exitCode}</span>}
              {item.nodeId && <span>{text('syncNode')}: {config.nodes.find(node => node.id === item.nodeId)?.name}</span>}
            </div>
            <div className="flex gap-1.5"><Button size="sm" variant="outline" disabled={pending || active} onClick={() => editScript(item)}><Pencil className="size-3.5" />{text('edit')}</Button>
              <Button size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" aria-label={text('delete')} disabled={pending || active} onClick={() => void run(() => onSave({ ...config, scripts: config.scripts.filter(value => value.id !== item.id) }))}><Trash2 className="size-3.5" /></Button>
              {active ? <Button size="sm" variant="outline" disabled={pending} onClick={() => void run(() => onCommand({ type: 'script-stop', scriptId: item.id }))}><Square className="size-3.5" />{text('stop')}</Button>
                : <Button size="sm" disabled={pending || !canRun || runtime?.status === 'missing' || runtime?.status === 'untracked'} onClick={() => void run(() => onCommand({ type: 'script-run', scriptId: item.id }))}><Play className="size-3.5" />{text('runScript')}</Button>}
            </div>
          </div>
          {runtime?.error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs leading-5 text-destructive">{runtime.error}</p>}
          {runtime?.output && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-foreground/5 p-3 font-mono text-xs leading-5">{runtime.output}</pre>}
        </section>
      })}
    {error && !script && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    <Dialog open={script !== null} onOpenChange={open => { if (!open && !pending) setScript(null) }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{text('addScript')}</DialogTitle><DialogDescription>{text('scriptHint')}</DialogDescription></DialogHeader>
        {script && <fieldset disabled={pending} className="min-w-0 space-y-4">
          <FormField label={text('scriptName')}><Input value={script.name} maxLength={80} onChange={event => setScript({ ...script, name: event.target.value })} /></FormField>
          <FormField label={text('scriptPath')} hint={text('scriptPathHint')}><Input value={script.path} onChange={event => setScript({ ...script, path: event.target.value })} placeholder="scripts/analyze.py" /></FormField>
          <FormField label={text('scriptArgs')}><textarea rows={3} className={textareaClass} value={argsText} onChange={event => setArgsText(event.target.value)} /></FormField>
          <div className="grid gap-4 sm:grid-cols-2"><FormField label={text('timeout')}><Input type="number" min={1} max={3600} value={script.timeoutSeconds} onChange={event => setScript({ ...script, timeoutSeconds: Number(event.target.value) })} /></FormField>
            <FormField label={text('syncNode')}><select className={selectClass} value={script.nodeId ?? ''} onChange={event => setScript({ ...script, nodeId: event.target.value || undefined })}>
              <option value="">{text('broadcast')}</option>{config.nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}
            </select></FormField></div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" onClick={() => setScript(null)}>{text('cancel')}</Button><Button type="button"
            disabled={!script.name.trim() || !script.path.trim() || !Number.isInteger(script.timeoutSeconds) || script.timeoutSeconds < 1 || script.timeoutSeconds > 3600}
            onClick={() => {
              const next = { ...script, name: script.name.trim(), path: script.path.trim(), args: argsText.split('\n').map(value => value.trim()).filter(Boolean) }
              void run(() => onSave({ ...config, scripts: [...config.scripts.filter(value => value.id !== next.id), next] }), () => setScript(null))
            }}>{pending && <LoaderCircle className="size-3.5 animate-spin" />}{text('save')}</Button></DialogFooter>
        </fieldset>}
      </DialogContent>
    </Dialog>
  </div></div>
}

function EmptyResource({ icon: Icon, message }: { icon: typeof Database; message: string }) {
  return <div className="flex flex-col items-center gap-3 py-7 text-center"><Icon className="size-7 text-muted-foreground/50" /><p className="max-w-sm text-xs leading-5 text-muted-foreground">{message}</p></div>
}

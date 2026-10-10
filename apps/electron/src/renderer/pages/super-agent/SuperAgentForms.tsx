import { WorkbenchSelect } from '@/components/ui/workbench-select'
import { useCallback, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, FolderOpen, ImagePlus, Trash2 } from 'lucide-react'
import { THINKING_LEVELS, type ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import type { SuperAgentAbilityProfile, SuperAgentEnvironment, SuperAgentEnvironmentStatus, SuperAgentNode } from '@craft-agent/shared/super-agent'
import type { LlmConnectionWithStatus, LoadedSource } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import { useAppShellContext } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'
import { nodeModels, useSuperAgentText } from './super-agent-ui'
import { recommendedThinking } from './super-agent-presets'

export const textareaClass = 'min-h-24 w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 text-sm leading-6 shadow-xs transition-colors outline-none placeholder:text-muted-foreground hover:border-primary/30 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50'

export function FormField({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <label className={cn('flex min-w-0 flex-col gap-2 text-sm', className)}>
    <span className="font-medium">{label}</span>
    {children}
    {hint && <span className="text-xs font-normal leading-5 text-muted-foreground">{hint}</span>}
  </label>
}

export function FormSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="space-y-4 rounded-2xl border border-border/70 bg-background p-4 shadow-xs sm:p-5">
    <div><h3 className="text-sm font-semibold">{title}</h3>{description && <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>}</div>
    {children}
  </section>
}

export function AgentAvatar({ avatar, name, className }: { avatar: string; name: string; className?: string }) {
  const isImage = /^data:image\/(?:png|jpe?g|webp);base64,/.test(avatar)
  return <span className={cn('inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-primary/10 text-xl text-primary ring-1 ring-primary/10', className)}>
    {isImage ? <img className="size-full object-cover" src={avatar} alt={name} /> : <span aria-hidden="true">{avatar || name.slice(0, 1)}</span>}
  </span>
}

export function AvatarEditor({ avatar, name, onChange }: { avatar: string; name: string; onChange: (value: string) => void }) {
  const text = useSuperAgentText()
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  async function upload(file?: File) {
    if (!file) return
    if (!/^image\/(?:png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      setError(text('invalidAvatar')); return
    }
    setError('')
    const objectUrl = URL.createObjectURL(file)
    try {
      const source = new Image()
      source.src = objectUrl
      await source.decode()
      const canvas = document.createElement('canvas')
      canvas.width = 160; canvas.height = 160
      const context = canvas.getContext('2d')
      if (!context) throw new Error(text('invalidAvatar'))
      const size = Math.min(source.naturalWidth, source.naturalHeight)
      context.drawImage(source, (source.naturalWidth - size) / 2, (source.naturalHeight - size) / 2, size, size, 0, 0, 160, 160)
      onChange(canvas.toDataURL('image/png'))
    } catch { setError(text('invalidAvatar')) } finally { URL.revokeObjectURL(objectUrl) }
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-4">
      <AgentAvatar avatar={avatar} name={name} className="size-16 rounded-2xl text-3xl" />
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {['✦', '◈', '🤖', '🦉', '🪐', '🧠', '🌱', '🐈'].map(value => <button key={value} type="button" aria-label={text('avatar') + ' ' + value} aria-pressed={avatar === value}
            className={cn('flex size-8 items-center justify-center rounded-lg border text-base transition-colors hover:bg-accent', avatar === value ? 'border-primary bg-primary/10' : 'border-transparent')}
            onClick={() => onChange(value)}>{value}</button>)}
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}><ImagePlus className="size-3.5" />{text('uploadAvatar')}</Button>
        <input ref={fileRef} type="file" className="hidden" accept="image/png,image/jpeg,image/webp" aria-label={text('uploadAvatar')} onChange={event => { void upload(event.target.files?.[0]); event.target.value = '' }} />
      </div>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>
}

export function NodeEditor({ node, connections, onChange, onRemove, sources = [], abilities = [] }: {
  node: SuperAgentNode
  connections: LlmConnectionWithStatus[]
  onChange: (node: SuperAgentNode) => void
  onRemove?: () => void
  sources?: LoadedSource[]
  abilities?: SuperAgentAbilityProfile[]
}) {
  const text = useSuperAgentText()
  const { t } = useTranslation()
  const connection = connections.find(item => item.slug === node.llmConnection)
  const models = nodeModels(connection)
  const patch = (updates: Partial<SuperAgentNode>) => onChange({ ...node, ...updates })
  function chooseConnection(slug: string) {
    const next = connections.find(item => item.slug === slug)
    const available = nodeModels(next)
    patch({ llmConnection: slug, model: next?.defaultModel && available.includes(next.defaultModel) ? next.defaultModel : available[0] ?? '' })
  }
  return <div className="space-y-5">
    <div className="flex items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2"><span className={cn('rounded-full px-2.5 py-1 text-xs font-medium', node.role === 'coordinator' ? 'bg-primary/10 text-primary' : 'bg-foreground/5 text-muted-foreground')}>{text(node.role)}</span><span className="text-xs text-muted-foreground">{text('allowAll')}</span></div>
      {onRemove && <Button variant="ghost" size="sm" className="text-destructive" onClick={onRemove}><Trash2 className="size-3.5" />{text('removeNode')}</Button>}
    </div>
    <AvatarEditor avatar={node.avatar} name={node.name} onChange={avatar => patch({ avatar })} />
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField label={text('name')}><Input value={node.name} maxLength={80} onChange={event => patch({ name: event.target.value })} /></FormField>
      <FormField label={text('connections')}><WorkbenchSelect value={node.llmConnection} onValueChange={value => chooseConnection(value)} options={[{ value: "", label: text('selectConnection') }, ...connections.map(item => ({ value: item.slug, label: <>{item.name}{item.isAuthenticated ? '' : ' · ' + text('unauthenticated')}</>, disabled: !item.isAuthenticated }))]} /></FormField>
      <FormField label={text('model')} hint={connection?.oauthProvider === 'tokennest' && connection.channelGroup
        ? text('inheritedGroup', { group: connection.channelGroups?.find(item => item.id === connection.channelGroup)?.name ?? connection.channelGroup }) : undefined}>
        {models.length > 0 ? <WorkbenchSelect value={node.model} onValueChange={value => patch({ model: value })} options={[...(!models.includes(node.model) ? [{ value: node.model, label: node.model || text('modelPlaceholder') }] : []), ...models.map(id => ({ value: id, label: id }))]} /> : <Input value={node.model} placeholder={text('modelPlaceholder')} onChange={event => patch({ model: event.target.value })} />}
      </FormField>
      <FormField label={text('thinking')} hint={text('thinkingRecommendation', { level: recommendedThinking(node) })}>
        <WorkbenchSelect value={node.thinkingLevel} onValueChange={value => patch({ thinkingLevel: value as ThinkingLevel })} options={[...THINKING_LEVELS.map(level => ({ value: level.id, label: t(level.nameKey) }))]} />
        <Button type="button" variant="outline" size="sm" onClick={() => patch({ thinkingLevel: recommendedThinking(node) })}>{text('applyThinkingRecommendation')}</Button>
      </FormField>
      <FormField label={text('speed')} hint={text('speedHint')}><Input type="number" min={0.1} max={60} step={0.1} value={node.maxCallsPerMinute} onChange={event => patch({ maxCallsPerMinute: Number(event.target.value) })} /></FormField>
      <FormField label={text('rating')} hint={text('ratingHint')}><WorkbenchSelect value={node.intelligenceRating} onValueChange={value => patch({ intelligenceRating: Number(value) })} options={[...[1, 2, 3, 4, 5].map(value => ({ value: value, label: '★'.repeat(value) + '☆'.repeat(5 - value) }))]} /></FormField>
    </div>
    <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4 accent-primary" checked={node.thinkingMode !== 'fixed'}
      onChange={event => patch({ thinkingMode: event.target.checked ? 'task' : 'fixed' })} />
      <span>{text('taskThinkingEnabled')}<span className="mt-1 block text-xs leading-5 text-muted-foreground">{text('taskThinkingHint')}</span></span>
    </label>
    <FormField label={text('description')}><textarea className={textareaClass} rows={3} value={node.description} onChange={event => patch({ description: event.target.value })} /></FormField>
    <FormField label={text('preferences')}><textarea className={textareaClass} rows={3} value={node.workPreferences} placeholder={text('preferencesPlaceholder')} onChange={event => patch({ workPreferences: event.target.value })} /></FormField>
    <FormField label={text('capabilities')} hint={text('capabilitiesHint')}><Input value={(node.capabilities ?? []).join(', ')}
      onChange={event => patch({ capabilities: [...new Set(event.target.value.split(',').map(value => value.trim()).filter(Boolean))] })} /></FormField>
    {sources.length > 0 && <FormSection title={text('sources')}>
      <ChoiceList items={sources.map(source => ({ id: source.config.slug, name: source.config.name, description: source.config.tagline }))}
        selected={node.sourceSlugs} onChange={sourceSlugs => patch({ sourceSlugs })} />
    </FormSection>}
    {abilities.length > 0 && <FormSection title={text('abilities')}>
      <ChoiceList items={abilities} selected={node.abilityProfileIds} onChange={abilityProfileIds => patch({ abilityProfileIds })} />
    </FormSection>}
  </div>
}

export function ChoiceList({ items, selected, onChange }: {
  items: Array<{ id: string; name: string; description?: string }>
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  return <div className="space-y-2">{items.map(item => <label key={item.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 p-3 hover:bg-accent/50">
    <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={selected.includes(item.id)} onChange={event => onChange(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} />
    <span className="min-w-0"><span className="block text-sm font-medium">{item.name}</span>{item.description && <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{item.description}</span>}</span>
  </label>)}</div>
}

export function EnvironmentEditor({ environment, onChange, status }: {
  environment: SuperAgentEnvironment
  onChange: (environment: SuperAgentEnvironment) => void
  status?: SuperAgentEnvironmentStatus
}) {
  const text = useSuperAgentText()
  const { activeWorkspaceId } = useAppShellContext()
  const fullControlId = useId()
  const choosePath = useCallback((workingDirectory: string) => onChange({ ...environment, workingDirectory }), [environment, onChange])
  const picker = useDirectoryPicker(choosePath)
  const modes = [
    { id: 'folder' as const, supported: true },
    { id: 'sandbox' as const, supported: true },
    { id: 'vm' as const, supported: true },
  ]
  return <div className="space-y-5">
    <div className="grid gap-3 sm:grid-cols-3">{modes.map(mode => <button key={mode.id} type="button" disabled={!mode.supported}
      className={cn('relative rounded-xl border p-4 text-left transition-colors', environment.kind === mode.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50', !mode.supported && 'cursor-not-allowed opacity-50')}
      onClick={() => onChange({
        ...environment, kind: mode.id,
        ...(mode.id === 'sandbox' && !environment.sandbox ? { sandbox: { runtime: 'docker' as const, image: 'node:22-bookworm' } } : {}),
        ...(mode.id === 'vm' && !environment.vm ? { vm: { workspaceId: activeWorkspaceId ?? '' } } : {}),
      })}>
      <span className="text-sm font-medium">{text(mode.id)}</span>
      {environment.kind === mode.id && <Check className="absolute right-3 top-3 size-3.5 text-primary" />}
      <span className="mt-1 block text-xs leading-5 text-muted-foreground">{text(mode.id === 'folder' ? 'folderDescription' : mode.id === 'sandbox' ? 'sandboxDescription' : 'vmDescription')}</span>
    </button>)}</div>
    <FormField label={text('workingDirectory')}>
      <div className="flex gap-2"><Input value={environment.workingDirectory} onChange={event => choosePath(event.target.value)} placeholder="C:\Projects\my-workspace" />
        <Button type="button" variant="outline" onClick={picker.pickDirectory} title={text('pickDirectory')} aria-label={text('pickDirectory')}><FolderOpen className="size-4" /></Button></div>
    </FormField>
    {environment.kind === 'sandbox' && <div className="grid gap-4 sm:grid-cols-2">
      <FormField label={text('containerRuntime')}><WorkbenchSelect value={environment.sandbox?.runtime ?? 'docker'} onValueChange={value => onChange({ ...environment, sandbox: { runtime: value as 'docker' | 'podman', image: environment.sandbox?.image ?? 'node:22-bookworm' } })} options={[{ value: "docker", label: "Docker" }, { value: "podman", label: "Podman" }]} /></FormField>
      <FormField label={text('containerImage')}><Input value={environment.sandbox?.image ?? ''} onChange={event => onChange({ ...environment, sandbox: { runtime: environment.sandbox?.runtime ?? 'docker', image: event.target.value } })} /></FormField>
    </div>}
    {environment.kind === 'vm' && <FormField label={text('vmWorkspace')}><Input value={environment.vm?.workspaceId ?? ''} onChange={event => onChange({ ...environment, vm: { workspaceId: event.target.value } })} /></FormField>}
    {environment.kind === 'folder' && <p className="rounded-lg bg-foreground/5 px-3 py-2 text-xs leading-5 text-muted-foreground">{text('folderIsolation')}</p>}
    <FormSection title={text('permissions')}>
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0 space-y-2"><label htmlFor={fullControlId} className="cursor-pointer text-sm font-semibold">{text('fullControl')}</label><p id={fullControlId + '-description'} className="text-xs leading-5 text-muted-foreground">{text('fullControlDescription')}</p></div>
        <Switch id={fullControlId} type="button" className="mt-0.5" checked={environment.fullControl === true} aria-describedby={fullControlId + '-description'} onCheckedChange={fullControl => onChange({ ...environment, fullControl })} />
      </div>
      {environment.fullControl ? <p role="status" className="rounded-lg bg-primary/5 px-3 py-2 text-xs leading-5 text-muted-foreground">{text('fullControlBoundary')}</p>
        : <details className="group/permissions border-t border-border/60 pt-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-medium text-muted-foreground">{text('advancedPermissions')}<ChevronDown className="size-3.5 transition-transform group-open/permissions:rotate-180" /></summary>
          <div className="mt-4 space-y-3">
            <p className="text-xs leading-5 text-muted-foreground">{text('permissionHint')}</p>
            {environment.kind === 'folder' && <p className="text-xs leading-5 text-muted-foreground">{text('folderPrograms')}</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              {(['readFiles', 'writeFiles', 'runPrograms', 'browser'] as const).map(key => <label key={key} className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-3 text-sm">
                <span>{text(key)}</span><input type="checkbox" className="size-4 accent-primary" checked={environment.permissions[key]}
                  onChange={event => onChange({ ...environment, permissions: { ...environment.permissions, [key]: event.target.checked } })} />
              </label>)}
            </div>
          </div>
        </details>}
    </FormSection>
    <FormSection title={text('actionGates')}>
      <p className="text-xs leading-5 text-muted-foreground">{text('actionGatesHint')}</p>
      <label className="flex cursor-pointer items-start justify-between gap-4 text-sm"><span>{text('autoReview')}<span className="mt-1 block text-xs leading-5 text-muted-foreground">{text('autoReviewHint')}</span></span>
        <input type="checkbox" className="mt-1 size-4 accent-primary" disabled={environment.fullControl === true} checked={environment.safety?.autoReview === true}
          onChange={event => onChange({ ...environment, safety: { customRules: environment.safety?.customRules ?? [], autoReview: event.target.checked } })} />
      </label>
      <p className="text-xs leading-5 text-muted-foreground">{text('customRulesHint')}</p>
      {(environment.safety?.customRules ?? []).map((rule, index) => <div key={index} className="grid gap-2 rounded-lg border border-border/60 p-3">
        <Input aria-label={text('ruleTool')} placeholder="mcp__source__tool" value={rule.toolName} onChange={event => onChange({ ...environment, safety: { autoReview: environment.safety?.autoReview ?? false, customRules: environment.safety!.customRules.map((item, i) => i === index ? { ...item, toolName: event.target.value } : item) } })} />
        <WorkbenchSelect value={rule.effect} options={[{ value: 'deny', label: text('ruleDeny') }, { value: 'require-human', label: text('ruleHuman') }]}
          onValueChange={value => onChange({ ...environment, safety: { autoReview: environment.safety?.autoReview ?? false, customRules: environment.safety!.customRules.map((item, i) => i === index ? { ...item, effect: value as 'deny' | 'require-human' } : item) } })} />
        <Input aria-label={text('ruleReason')} placeholder={text('ruleReason')} value={rule.reason} onChange={event => onChange({ ...environment, safety: { autoReview: environment.safety?.autoReview ?? false, customRules: environment.safety!.customRules.map((item, i) => i === index ? { ...item, reason: event.target.value } : item) } })} />
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ ...environment, safety: { autoReview: environment.safety?.autoReview ?? false, customRules: environment.safety!.customRules.filter((_, i) => i !== index) } })}>{text('delete')}</Button>
      </div>)}
      <Button type="button" size="sm" variant="outline" disabled={(environment.safety?.customRules.length ?? 0) >= 100} onClick={() => onChange({ ...environment, safety: { autoReview: environment.safety?.autoReview ?? false, customRules: [...(environment.safety?.customRules ?? []), { toolName: '', effect: 'deny', reason: '' }] } })}>{text('addCustomRule')}</Button>
    </FormSection>
    <ServerDirectoryBrowser open={picker.showServerBrowser} mode={picker.serverBrowserMode} initialPath={environment.workingDirectory}
      onSelect={picker.confirmServerBrowser} onCancel={picker.cancelServerBrowser} />
  </div>
}

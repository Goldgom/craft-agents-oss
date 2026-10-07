import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Circle, LoaderCircle, Plus, Settings2, Sparkles } from 'lucide-react'
import type { SuperAgentConfig } from '@craft-agent/shared/super-agent'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { AgentAvatar, AvatarEditor, EnvironmentEditor, FormField, NodeEditor } from './SuperAgentForms'
import { SuperAgentPresetPicker } from './SuperAgentPresetPicker'
import { Switch } from '@/components/ui/switch'
import { applyPreset, configError, createConfig, createNode, nodeModels, useSuperAgentText, type SuperAgentPreset } from './super-agent-ui'

export function SuperAgentSetup({ connections, defaultConnection, onSave, onOpenAiSettings, onLoginTokenNest, onRefreshConnections }: {
  connections: LlmConnectionWithStatus[]
  defaultConnection?: string
  onSave: (config: SuperAgentConfig) => Promise<void>
  onOpenAiSettings?: () => void
  onLoginTokenNest: () => Promise<void>
  onRefreshConnections: () => Promise<void>
}) {
  const text = useSuperAgentText()
  const [config, setConfig] = useState(() => createConfig(connections, text, defaultConnection))
  const [step, setStep] = useState(0)
  const [preset, setPreset] = useState<SuperAgentPreset>('daily')
  const [presetConnectionSlug, setPresetConnectionSlug] = useState(config.nodes[0]?.llmConnection ?? '')
  const [selectedNodeId, setSelectedNodeId] = useState(config.nodes[0]?.id ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const tokenNest = connections.find(item => item.oauthProvider === 'tokennest' && item.isAuthenticated && nodeModels(item).length)
  const readyConnections = connections.filter(item => item.isAuthenticated)
  const presetConnection = connections.find(item => item.slug === presetConnectionSlug && item.isAuthenticated && nodeModels(item).length)
    ?? connections.find(item => item.isAuthenticated && nodeModels(item).length)
  const selectedNode = config.nodes.find(node => node.id === selectedNodeId) ?? config.nodes[0]
  const steps = ['identity', 'team', 'environment', 'review'] as const

  useEffect(() => {
    if (!connections.some(item => item.isAuthenticated && nodeModels(item).length)) return
    setConfig(current => {
      if (current.nodes.some(node => node.llmConnection)) return current
      const connection = connections.find(item => item.slug === defaultConnection && item.isAuthenticated && nodeModels(item).length)
        ?? connections.find(item => item.isAuthenticated && nodeModels(item).length)!
      if (preset !== 'custom') return applyPreset(current, preset, connection, text)
      return { ...current, nodes: current.nodes.map(node => ({ ...node,
        llmConnection: connection.slug, model: createNode(node.role, [connection], text).model,
      })) }
    })
  }, [connections, defaultConnection])

  async function run(action: () => Promise<void>) {
    if (pending) return
    setPending(true); setError('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setPending(false) }
  }
  function next() {
    setError('')
    const validation = step === 0 ? !config.name.trim() ? text('nameRequired') : null
      : configError(step === 1 ? { ...config, environment: { ...config.environment, workingDirectory: 'setup-pending' } } : config, connections, text)
    if (validation) { setError(validation); return }
    setStep(value => Math.min(3, value + 1))
  }
  function choosePreset(value: SuperAgentPreset) {
    setPreset(value)
    if (value !== 'custom' && presetConnection) {
      const nextConfig = applyPreset(config, value, presetConnection, text)
      setConfig(nextConfig); setSelectedNodeId(nextConfig.nodes[0].id)
    }
  }
  function addWorker() {
    const node = createNode('worker', connections, text, defaultConnection)
    setConfig(current => ({ ...current, nodes: [...current.nodes, node] })); setSelectedNodeId(node.id)
  }

  return <div className="h-full min-h-0 overflow-y-auto">
    <div className="mx-auto max-w-4xl px-6 py-8 sm:px-10">
      <div className="mb-8">
        <span className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Sparkles className="size-6" /></span>
        <h1 className="text-2xl font-semibold tracking-tight">{text('welcome')}</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{text('welcomeDescription')}</p>
      </div>
      <ol className="mb-8 grid grid-cols-4 gap-2" aria-label={text('review')}>
        {steps.map((key, index) => <li key={key} className={cn('flex items-center gap-2 border-b-2 pb-3 text-xs sm:text-sm', index === step ? 'border-primary font-medium text-primary' : 'border-border text-muted-foreground')}>
          <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full text-[10px]', index <= step ? 'bg-primary/10 text-primary' : 'bg-foreground/5')}>
            {index < step ? <Check className="size-3" /> : index + 1}
          </span><span className="min-w-0 break-words">{text(key)}</span>
        </li>)}
      </ol>
      <fieldset className="min-w-0 space-y-6" disabled={pending}>
        {step === 0 && <>
          <div className="space-y-5 rounded-2xl border border-border/70 p-6">
            <AvatarEditor avatar={config.avatar} name={config.name} onChange={avatar => setConfig(current => ({ ...current, avatar }))} />
            <FormField label={text('assistantName')}><Input className="max-w-md" value={config.name} maxLength={80} onChange={event => setConfig(current => ({ ...current, name: event.target.value }))} autoFocus /></FormField>
          </div>
          <section className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h2 className="text-sm font-semibold">{text('connections')}</h2><p className="mt-1 max-w-lg text-xs leading-5 text-muted-foreground">{text('reusedConnections')}</p></div>
              <div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={() => void run(onRefreshConnections)}>{text('refresh')}</Button>
                {onOpenAiSettings && <Button type="button" variant="outline" size="sm" onClick={onOpenAiSettings}><Settings2 className="size-3.5" />{text('manageConnections')}</Button>}</div>
            </div>
            <div className="rounded-xl border border-border/70 p-4">
              {readyConnections.length ? <div className="flex flex-wrap gap-2">{readyConnections.map(item => <span key={item.slug} className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs text-emerald-600 dark:text-emerald-400"><Check className="size-3" />{item.name}</span>)}</div>
                : <p className="mb-3 text-xs leading-5 text-muted-foreground">{text('noConnections')}</p>}
              {!tokenNest && <Button type="button" className={readyConnections.length ? 'mt-3' : ''} size="sm" variant="outline" onClick={() => void run(onLoginTokenNest)}>{text('login')}</Button>}
            </div>
          </section>
          <SuperAgentPresetPicker connections={connections} connectionSlug={presetConnection?.slug ?? ''}
            onConnectionChange={slug => {
              setPresetConnectionSlug(slug)
              const connection = connections.find(item => item.slug === slug)!
              const nextConfig = applyPreset(config, preset, connection, text)
              setConfig(nextConfig); setSelectedNodeId(nextConfig.nodes[0].id)
            }} preset={preset} onChoose={choosePreset} text={text} />
        </>}
        {step === 1 && <>
          <p className="rounded-xl bg-primary/5 p-4 text-xs leading-5 text-muted-foreground">{text('coordinatorRule')}</p>
          <div className="flex flex-wrap items-center gap-2">
            {config.nodes.map(node => <button key={node.id} type="button" onClick={() => setSelectedNodeId(node.id)}
              className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors', selectedNode.id === node.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent')}>
              <AgentAvatar avatar={node.avatar} name={node.name} className="size-6 rounded-md text-sm" /><span className="max-w-36 truncate">{node.name}</span>
              {node.role === 'coordinator' && <Sparkles className="size-3 text-primary" />}
            </button>)}
            <Button variant="outline" size="sm" type="button" onClick={addWorker}><Plus className="size-3.5" />{text('addWorker')}</Button>
          </div>
          <div className="rounded-xl border border-border/70 p-5">
            <NodeEditor node={selectedNode} connections={connections}
              onChange={node => setConfig(current => ({ ...current, nodes: current.nodes.map(item => item.id === node.id ? node : item) }))}
              onRemove={selectedNode.role === 'worker' && config.nodes.filter(node => node.role === 'worker').length > 1
                ? () => { setConfig(current => ({ ...current, nodes: current.nodes.filter(node => node.id !== selectedNode.id) })); setSelectedNodeId(config.nodes[0].id) } : undefined} />
          </div>
          <FormField label={text('idleInterval')} hint={text('idleHint')}><Input type="number" min={1} max={1440} step={1} value={config.idleInspectionMinutes} className="max-w-40" onChange={event => setConfig(current => ({ ...current, idleInspectionMinutes: Number(event.target.value) }))} /></FormField>
          <div className="flex items-start justify-between gap-4"><label htmlFor="setup-continuous-work" className="text-sm">{text('continuousWork')}<span className="mt-1 block text-xs leading-5 text-muted-foreground">{text('continuousWorkHint')}</span></label>
            <Switch id="setup-continuous-work" type="button" checked={config.continuousWork === true} onCheckedChange={continuousWork => setConfig(current => ({ ...current, continuousWork }))} /></div>
        </>}
        {step === 2 && <EnvironmentEditor environment={config.environment} onChange={environment => setConfig(current => ({ ...current, environment }))} />}
        {step === 3 && <div className="space-y-5 rounded-2xl border border-border/70 p-6">
          <div className="flex items-center gap-4"><AgentAvatar avatar={config.avatar} name={config.name} className="size-14 rounded-2xl text-3xl" />
            <div><h2 className="text-lg font-semibold">{config.name}</h2><p className="mt-1 text-xs text-muted-foreground">{text('setupSummary', { workers: config.nodes.filter(node => node.role === 'worker').length, minutes: config.idleInspectionMinutes })}</p></div>
          </div>
          <p className="text-xs text-muted-foreground">{text('continuousWork')}：{text(config.continuousWork ? 'enabled' : 'disabled')}</p>
          <div className="space-y-2">{config.nodes.map(node => <div key={node.id} className="flex items-center gap-3 rounded-lg bg-foreground/3 p-3">
            <AgentAvatar avatar={node.avatar} name={node.name} className="size-8 rounded-lg text-base" />
            <div className="min-w-0 flex-1"><p className="text-sm font-medium">{node.name}<span className="ml-2 text-xs font-normal text-muted-foreground">{text(node.role === 'coordinator' ? 'coordinator' : 'worker')}</span></p><p className="mt-0.5 truncate text-xs text-muted-foreground">{connections.find(connection => connection.slug === node.llmConnection)?.name} · {node.model}</p></div>
            <Check className="size-4 text-emerald-500" />
          </div>)}</div>
          <div className="border-t border-border/70 pt-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-xs"><span className="font-medium text-muted-foreground">{text('permissions')}</span><span>{text(config.environment.fullControl ? 'fullControlEnabled' : 'limitedControl')}</span></div><p className="text-xs font-medium text-muted-foreground">{text('workingDirectory')}</p><p className="mt-1 break-all font-mono text-xs">{config.environment.workingDirectory}</p>
            {config.environment.fullControl ? <p className="mt-3 text-xs leading-5 text-muted-foreground">{text('fullControlBoundary')}</p>
              : <div className="mt-3 flex flex-wrap gap-2">{(['readFiles', 'writeFiles', 'runPrograms', 'browser'] as const).filter(key => config.environment.permissions[key]).map(key => <span key={key} className="rounded-full bg-foreground/5 px-2 py-1 text-xs">{text(key)}</span>)}</div>}
          </div>
        </div>}
      </fieldset>
      {error && <p role="alert" className="mt-5 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
      <div className="mt-8 flex items-center justify-between border-t border-border/70 pt-5">
        {step > 0 ? <Button type="button" variant="ghost" disabled={pending} onClick={() => { setError(''); setStep(value => value - 1) }}><ArrowLeft className="size-4" />{text('back')}</Button>
          : <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Circle className="size-2 fill-emerald-500 stroke-emerald-500" />{text('title')}</span>}
        {step < 3 ? <Button type="button" disabled={pending} onClick={next}>{text('next')}<ArrowRight className="size-4" /></Button>
          : <Button type="button" disabled={pending} onClick={() => {
            const validation = configError(config, connections, text)
            if (validation) { setError(validation); return }
            void run(() => onSave(config))
          }}>{pending ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{text('create')}</Button>}
      </div>
    </div>
  </div>
}

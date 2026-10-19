import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SuperAgentCommand, SuperAgentSnapshot, SuperAgentState } from '@tokenbird/shared/super-agent'
import type { FolderSourceConfig, LoadedSource } from '@tokenbird/shared/sources'
import type { AutomationsConfig } from '@tokenbird/shared/automations'
import type { CredentialId } from '@tokenbird/shared/credentials/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Markdown } from '@/components/markdown'
import { FormField, textareaClass } from './SuperAgentForms'

export function SuperAgentReports({ state }: { state: SuperAgentState }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh')
  return <div className="h-full space-y-4 overflow-y-auto p-6"><h2 className="font-semibold">{zh ? '汇报数据区' : 'Reports'}</h2>
    {!(state.reports?.length) && <p className="text-sm text-muted-foreground">{zh ? '暂无汇报' : 'No reports yet'}</p>}
    {[...(state.reports ?? [])].reverse().map(report => <article key={report.id} className="space-y-2 rounded-xl border border-border p-4">
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>#{report.sequence}</span><span>{report.kind}</span><span>{report.verification}</span><span>{report.nodeId}</span><span>{new Date(report.createdAt).toLocaleString()}</span><span>{report.sequence <= (state.consumedReportSequence ?? 0) ? zh ? '已处理' : 'Consumed' : zh ? '待处理' : 'Pending'}</span></div>
      <Markdown>{report.content}</Markdown>
      {!!report.artifactIds.length && <p className="break-all text-xs text-muted-foreground">{report.artifactIds.join(', ')}</p>}
    </article>)}
  </div>
}

export function SuperAgentRequirements({ state }: { state: SuperAgentState }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh')
  return <div className="space-y-3 p-4"><h3 className="text-sm font-semibold">{zh ? '用户需求' : 'User requirements'}</h3>
    {!(state.intents?.length) && <p className="text-xs text-muted-foreground">{zh ? '在对话中描述目标，交互节点会将需求写入此处。' : 'Describe your goal in chat. Interaction will record the requirements here.'}</p>}
    {[...(state.intents ?? [])].reverse().map(intent => <article key={intent.id} className="space-y-2 rounded-lg border border-border p-3 text-sm"><p>{intent.goal}</p><p className="text-xs text-muted-foreground">{intent.status ?? 'active'} · v{intent.revision ?? 1}</p>{!!intent.constraints.length && <p className="text-xs">{zh ? '约束：' : 'Constraints: '}{intent.constraints.join('；')}</p>}{!!intent.acceptanceCriteria.length && <p className="text-xs">{zh ? '验收：' : 'Acceptance: '}{intent.acceptanceCriteria.join('；')}</p>}</article>)}
  </div>
}

interface ResourceData {
  savedCredentialWorkspaceId: string
  credentialWorkspaceId: string
  sources: LoadedSource[]
  credentials: Array<{ id: CredentialId; username?: string; kind?: string; url?: string; hasSecret: boolean }>
  automations: AutomationsConfig
  history: Array<{ id: string; ts: number; ok: boolean; prompt?: string; error?: string }>
  encryptedExport?: unknown
  executionResults?: unknown[]
  availableImports: { sources: Array<{ slug: string; name: string }>; credentials: Array<{ id: CredentialId; username?: string }>; automations: AutomationsConfig }
}

export function SuperAgentScopedResources({ workspaceId, onCommand, onSources, initialTab = 'sources' }: {
  initialTab?: 'sources' | 'credentials' | 'automations' | 'import'; workspaceId: string; onCommand: (command: SuperAgentCommand) => Promise<SuperAgentSnapshot>; onSources: (sources: LoadedSource[]) => void
}) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh'), tr = (zhText: string, en: string) => zh ? zhText : en
  const [data, setData] = useState<ResourceData>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'sources' | 'credentials' | 'automations' | 'import'>(initialTab)
  const [sourceEditor, setSourceEditor] = useState(''), [automationEditor, setAutomationEditor] = useState('')
  const [bundlePassword, setBundlePassword] = useState('')
  const [name, setName] = useState(''), [secret, setSecret] = useState(''), [username, setUsername] = useState(''), [url, setUrl] = useState(''), [sourceSlug, setSourceSlug] = useState('')
  async function run(operation: Extract<SuperAgentCommand, { type: 'resources' }>['operation'], value?: unknown) {
    setBusy(true); setError('')
    try {
      const result = await onCommand({ type: 'resources', operation, value })
      const next = result.resources as ResourceData
      setData(next); onSources(next.sources)
      if (!automationEditor || operation === 'import') setAutomationEditor(JSON.stringify(next.automations, null, 2))
      return next
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); throw error } finally { setBusy(false) }
  }
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => { void runRef.current('get').catch(() => {}) }, [workspaceId])
  const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm'
  function newSource(type: 'api' | 'mcp' | 'local') {
    const slug = `${type}-${crypto.randomUUID().slice(0, 8)}`
    setSourceEditor(JSON.stringify({ id: crypto.randomUUID(), slug, name: tr('新数据源', 'New source'), type, provider: 'custom', enabled: true,
      createdAt: Date.now(), updatedAt: Date.now(), ...(type === 'mcp' ? { mcp: { transport: 'http', url: 'https://example.com/mcp', authType: 'none' } } : type === 'api' ? { api: { baseUrl: 'https://example.com', authType: 'none' } } : { local: { path: '' } }) }, null, 2))
  }
  return <div className="h-full overflow-y-auto"><div className="mx-auto max-w-4xl space-y-5 p-6">
    <h2 className="font-semibold">{tr('共享资源库', 'Shared resources')}</h2><p className="text-xs text-muted-foreground">{tr('数据源、凭据和自动化由本工作区所有智能体共享，修改会同步生效。', 'Sources, credentials and automations are shared by all agents in this workspace.')}</p>
    <div className="flex flex-wrap gap-2">{(['sources', 'credentials', 'automations', 'import'] as const).map(key => <Button key={key} variant={key === tab ? 'default' : 'outline'} onClick={() => setTab(key)}>{({ sources: tr('数据源', 'Sources'), credentials: tr('凭据库', 'Credentials'), automations: tr('自动化', 'Automations'), import: tr('导入 / 导出', 'Import / Export') })[key]}</Button>)}<Button variant="ghost" disabled={busy} onClick={() => void run('get').catch(() => {})}>{tr('刷新', 'Refresh')}</Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!data ? <p className="text-sm text-muted-foreground">{tr('正在加载…', 'Loading…')}</p> : <fieldset disabled={busy} className="min-w-0 space-y-5">
      {tab === 'sources' && <>
        <div className="flex gap-2">{(['api', 'mcp', 'local'] as const).map(type => <Button key={type} variant="outline" onClick={() => newSource(type)}>+ {type.toUpperCase()}</Button>)}</div>
        {data.sources.map(source => <div key={source.config.slug} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"><div><p className="text-sm font-medium">{source.config.name}</p><p className="text-xs text-muted-foreground">{source.config.slug} · {source.config.type} · {source.config.connectionStatus ?? (source.config.enabled ? 'enabled' : 'disabled')}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setSourceEditor(JSON.stringify(source.config, null, 2))}>{tr('编辑', 'Edit')}</Button><Button size="sm" variant="outline" onClick={() => void run('save-sources', { configs: [{ ...source.config, enabled: !source.config.enabled }] }).catch(() => {})}>{source.config.enabled ? tr('停用', 'Disable') : tr('启用', 'Enable')}</Button>{(source.config.mcp?.authType === 'oauth' || source.config.api?.authType === 'oauth') && <Button size="sm" variant="outline" onClick={() => {
          setBusy(true); void window.electronAPI.performOAuth({ sourceSlug: source.config.slug, resourceScope: 'super-agent' }).then(result => { if (!result.success) throw new Error(result.error); return run('get') }).catch(error => setError(String(error))).finally(() => setBusy(false))
        }}>{tr('授权', 'Authorize')}</Button>}<Button size="sm" variant="ghost" onClick={() => void run('save-sources', { configs: [], deletedSlugs: [source.config.slug] }).catch(() => {})}>{tr('删除', 'Delete')}</Button></div></div>)}
        {sourceEditor && <div className="space-y-3"><FormField label={tr('数据源配置', 'Source configuration')}><textarea aria-label={tr('数据源配置', 'Source configuration')} className={textareaClass + ' min-h-72 font-mono text-xs'} value={sourceEditor} onChange={event => setSourceEditor(event.target.value)} /></FormField><Button onClick={() => { try { const config = JSON.parse(sourceEditor) as FolderSourceConfig; void run('save-sources', { configs: [config] }).then(() => setSourceEditor('')).catch(() => {}) } catch (error) { setError(String(error)) } }}>{tr('保存数据源', 'Save source')}</Button></div>}
      </>}
      {tab === 'credentials' && <>
        {data.credentials.map(entry => <div key={JSON.stringify(entry.id)} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"><div><p className="text-sm">{entry.id.name ?? entry.id.sourceId}</p><p className="text-xs text-muted-foreground">{entry.id.type} {entry.username} {entry.url}</p></div><Button variant="ghost" onClick={() => void run('save-credentials', [{ op: 'delete', id: entry.id }]).catch(() => {})}>{tr('删除', 'Delete')}</Button></div>)}
        <div className="grid gap-4 rounded-xl border border-border p-4 sm:grid-cols-2">
          <FormField label={tr('用途', 'Use')}><select className={inputClass} value={sourceSlug} onChange={event => setSourceSlug(event.target.value)}><option value="">{tr('保存账户 / 密钥', 'Saved account / secret')}</option>{data.sources.map(source => <option key={source.config.slug} value={source.config.slug}>{source.config.name}</option>)}</select></FormField>
          <FormField label={tr('名称', 'Name')}><Input value={name} onChange={event => setName(event.target.value)} autoComplete="off" /></FormField>
          <FormField label={tr('用户名', 'Username')}><Input value={username} onChange={event => setUsername(event.target.value)} autoComplete="off" /></FormField>
          <FormField label={tr('网站地址', 'Website')}><Input value={url} onChange={event => setUrl(event.target.value)} /></FormField>
          <FormField label={tr('密码 / API Key', 'Password / API key')}><Input type="password" value={secret} onChange={event => setSecret(event.target.value)} autoComplete="new-password" /></FormField>
          <div className="flex items-end"><Button disabled={!secret || !sourceSlug && !name} onClick={() => {
            const source = data.sources.find(source => source.config.slug === sourceSlug)
            const type = !source ? 'saved_credential' : source.config.api?.authType === 'basic' ? 'source_basic' : source.config.mcp || source.config.api?.authType === 'bearer' ? 'source_bearer' : 'source_apikey'
            const id: CredentialId = source ? { type, workspaceId: data.credentialWorkspaceId, sourceId: sourceSlug } : { type, workspaceId: data.savedCredentialWorkspaceId, name }
            void run('save-credentials', [{ op: 'upsert', id, credential: { value: type === 'source_basic' ? btoa(String.fromCharCode(...new TextEncoder().encode(`${username}:${secret}`))) : secret, ...(username ? { username } : {}), ...(!source ? { credentialKind: 'secret', ...(url ? { credentialUrl: url } : {}) } : {}) } }]).then(() => { setSecret(''); setName(''); setUsername(''); setUrl('') }).catch(() => {})
          }}>{tr('保存凭据', 'Save credential')}</Button></div>
        </div>
      </>}
      {tab === 'automations' && <>
        <Button variant="outline" onClick={() => {
          try {
            const config = JSON.parse(automationEditor) as AutomationsConfig
            config.automations.SchedulerTick = [...(config.automations.SchedulerTick ?? []), { id: crypto.randomUUID().slice(0, 8), name: tr('新定时任务', 'New schedule'), cron: '0 9 * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, enabled: false, actions: [{ type: 'prompt', prompt: tr('请填写工作目标', 'Describe the work to perform') }] }]
            setAutomationEditor(JSON.stringify(config, null, 2))
          } catch (error) { setError(String(error)) }
        }}>{tr('添加定时任务', 'Add schedule')}</Button>
        <textarea aria-label={tr('自动化配置', 'Automation configuration')} className={textareaClass + ' min-h-80 font-mono text-xs'} value={automationEditor} onChange={event => setAutomationEditor(event.target.value)} />
        <Button onClick={() => { try { void run('save-automations', JSON.parse(automationEditor)).catch(() => {}) } catch (error) { setError(String(error)) } }}>{tr('保存自动化', 'Save automations')}</Button>
        {Object.entries(data.automations.automations).flatMap(([event, matchers]) => matchers.map((matcher, index) => <div key={matcher.id ?? `${event}-${index}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"><span className="text-sm">{matcher.name ?? matcher.id} · {event} · {matcher.enabled === false ? tr('停用', 'Disabled') : tr('启用', 'Enabled')}</span><div className="flex gap-2">{(['test-automation', 'replay-automation'] as const).map(operation => <Button key={operation} size="sm" variant="outline" disabled={!matcher.id} onClick={() => void run(operation, { id: matcher.id }).catch(() => {})}>{operation === 'test-automation' ? tr('测试执行', 'Test run') : tr('重放', 'Replay')}</Button>)}</div></div>))}
        {!!data.executionResults?.length && <pre className="overflow-x-auto rounded-lg bg-foreground/5 p-3 text-xs">{JSON.stringify(data.executionResults, null, 2)}</pre>}
        <h3 className="text-sm font-semibold">{tr('运行历史', 'Run history')}</h3>{[...data.history].reverse().map((entry, index) => <p key={`${entry.ts}-${index}`} className="break-all text-xs">{new Date(entry.ts).toLocaleString()} · {entry.id} · {entry.ok ? 'OK' : entry.error}</p>)}
      </>}
      {tab === 'import' && <>
        <p className="text-sm text-muted-foreground">{tr('导出数据源和自动化配置。凭据密钥不会导出；导入凭据时请使用写入格式。', 'Export source and automation configuration. Credential secrets are omitted; credentials can be imported as write-only changes.')}</p>
        <Button onClick={() => {
          const blob = new Blob([JSON.stringify({ version: 1, sources: data.sources.map(source => source.config), automations: data.automations }, null, 2)], { type: 'application/json' })
          const href = URL.createObjectURL(blob), link = document.createElement('a')
          link.href = href; link.download = 'shared-agent-resources.json'; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000)
        }}>{tr('导出配置', 'Export configuration')}</Button>
        <FormField label={tr('加密备份密码（至少 8 个字符）', 'Backup password (at least 8 characters)')}><Input type="password" autoComplete="new-password" value={bundlePassword} onChange={event => setBundlePassword(event.target.value)} /></FormField>
        <Button disabled={bundlePassword.length < 8} onClick={() => void run('export', { password: bundlePassword }).then(result => {
          const href = URL.createObjectURL(new Blob([JSON.stringify(result.encryptedExport)], { type: 'application/json' })), link = document.createElement('a')
          link.href = href; link.download = 'shared-agent-resources.encrypted.json'; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000)
        }).catch(() => {})}>{tr('导出加密备份（含凭据）', 'Export encrypted backup (includes credentials)')}</Button>
        <input type="file" accept="application/json,.json" aria-label={tr('导入配置', 'Import configuration')} onChange={event => {
          const file = event.target.files?.[0]
          if (file) void file.text().then(text => { const bundle = JSON.parse(text); return run('import', bundle.format === 'tokenbird-shared-resources' ? { encrypted: bundle, password: bundlePassword } : bundle) }).catch(error => setError(String(error)))
          event.target.value = ''
        }} />
      </>}
    </fieldset>}
  </div></div>
}

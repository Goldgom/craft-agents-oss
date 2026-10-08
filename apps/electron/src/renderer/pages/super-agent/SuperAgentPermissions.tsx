import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { canShareSuperAgentPermission, superAgentPermissionEnvironmentKey, type SuperAgentCommand, type SuperAgentConfig, type SuperAgentSnapshot } from '@craft-agent/shared/super-agent'
import { useAppShellContext } from '@/context/AppShellContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ApprovalCard, SuperAgentPermissionHistory } from './SuperAgentConversation'
import { nodeLabel } from './SuperAgentCollaboration'
import { ordinaryPermissionHeads } from './super-agent-activity'
import { formatTimestamp, useSuperAgentText } from './super-agent-ui'

export function SuperAgentPermissions({ snapshot, busy, onCommand }: {
  snapshot: SuperAgentSnapshot & { config: SuperAgentConfig }
  busy: boolean
  onCommand: (command: SuperAgentCommand) => Promise<unknown>
}) {
  const text = useSuperAgentText()
  const { pendingPermissions, onRespondToPermission } = useAppShellContext()
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const { config, state } = snapshot
  const inbox = snapshot.permissionRequests ?? []
  const approvals = inbox.filter(request => request.status === 'pending')
  const sessionIds = new Set(state.nodes.flatMap(node => node.sessionId ? [node.sessionId] : []))
  const ordinary = ordinaryPermissionHeads(sessionIds, pendingPermissions, inbox)
  const grants = state.permissionGrants ?? []
  const query = search.trim().toLocaleLowerCase()
  const visible = [...grants].filter(grant => !query || [grant.description, grant.scope.toolName, grant.scope.target, grant.scope.operation]
    .some(value => value.toLocaleLowerCase().includes(query))).sort((first, second) => second.createdAt - first.createdAt)
  const environmentKey = superAgentPermissionEnvironmentKey(config.environment)
  async function run(action: () => Promise<unknown>) {
    if (pending || busy) return
    setPending(true); setError('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setPending(false) }
  }
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-4xl space-y-6 p-6">
    <header><h2 className="flex items-center gap-2 text-lg font-semibold"><ShieldCheck className="size-5" />{text('permissionManagement')}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{text('permissionManagementHint')}</p></header>
    {config.environment.fullControl && <p className="rounded-lg bg-amber-500/10 p-3 text-xs leading-5 text-amber-700 dark:text-amber-400">{text('fullControlPermissionHint')}</p>}
    {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    <section className="space-y-3" aria-label={text('permissionInbox')}><h3 className="text-sm font-semibold">{text('permissionInbox')} · {approvals.length + ordinary.length}</h3>
      {!approvals.length && !ordinary.length && <p className="text-xs text-muted-foreground">{text('noPendingPermissions')}</p>}
      {approvals.map(request => <ApprovalCard key={request.id} owner={nodeLabel(config, request.nodeId, text)} request={request} pending={pending || busy}
        onRespond={allowed => { void run(() => onCommand({ type: 'permission-response', requestId: request.id, allowed })) }}
        onRemember={canShareSuperAgentPermission(request.scope) && config.nodes.find(node => node.id === request.nodeId)?.role === 'worker'
          ? () => { void run(() => onCommand({ type: 'permission-response', requestId: request.id, allowed: true, remember: true })) } : undefined} />)}
      {ordinary.map(request => <ApprovalCard key={request.requestId} owner={nodeLabel(config, state.nodes.find(node => node.sessionId === request.sessionId)?.nodeId ?? 'system', text)}
        request={request} pending={pending || busy || !onRespondToPermission} onRespond={allowed => { void run(async () => { await onRespondToPermission?.(request.sessionId, request.requestId, allowed, false) }) }} />)}
    </section>
    <section className="space-y-3" aria-label={text('sharedPermissions')}><h3 className="text-sm font-semibold">{text('sharedPermissions')} · {grants.length}</h3>
      <Input value={search} onChange={event => setSearch(event.target.value)} placeholder={text('searchPermissions')} aria-label={text('searchPermissions')} />
      {!visible.length && <p className="text-xs text-muted-foreground">{text(grants.length ? 'noMatchingPermissions' : 'noSharedPermissions')}</p>}
      {visible.map(grant => <article key={grant.id} className="space-y-3 rounded-xl border border-border/70 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><h4 className="break-words text-sm font-medium">{grant.description}</h4>
          <p className="mt-1 text-[11px] text-muted-foreground">{text('sharedPermissionCreator', { name: nodeLabel(config, grant.nodeId, text), time: formatTimestamp(grant.createdAt) })}</p></div>
          <Button size="sm" variant="outline" disabled={pending || busy} onClick={() => { void run(() => onCommand({ type: 'permission-revoke', grantId: grant.id })) }}>{text('revokeSharedPermission')}</Button></div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs"><dt className="text-muted-foreground">{text('toolActivity')}</dt><dd className="break-all">{grant.scope.toolName}</dd>
          <dt className="text-muted-foreground">{text('approvalTarget')}</dt><dd className="break-all font-mono">{grant.scope.target}</dd>
          <dt className="text-muted-foreground">{text('approvalOperation')}</dt><dd className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all font-mono">{grant.scope.operation}</dd></dl>
        {grant.environmentKey !== environmentKey && <p className="text-xs text-amber-700 dark:text-amber-400">{text('permissionEnvironmentMismatch')}</p>}
      </article>)}
    </section>
    <SuperAgentPermissionHistory snapshot={snapshot} />
  </div></div>
}

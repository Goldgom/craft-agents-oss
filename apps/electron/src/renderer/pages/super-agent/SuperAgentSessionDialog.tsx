import { useRef, useState } from 'react'
import { canShareSuperAgentPermission, type SuperAgentCommand, type SuperAgentConfig, type SuperAgentSnapshot } from '@tokenbird/shared/super-agent'
import { useAppShellContext } from '@/context/AppShellContext'
import { SessionDetailsDialog } from '@/components/app-shell/SessionDetailsDialog'
import { CredentialRequest } from '@/components/app-shell/input/structured/CredentialRequest'
import { ApprovalCard } from './SuperAgentConversation'
import { ordinaryPermissionHeads } from './super-agent-activity'
import { useSuperAgentText } from './super-agent-ui'

export function SuperAgentSessionDialog({ sessionId, snapshot, busy, onCommand, onClose }: {
  sessionId: string
  snapshot: SuperAgentSnapshot & { config: SuperAgentConfig }
  busy: boolean
  onCommand: (command: SuperAgentCommand) => Promise<unknown>
  onClose: () => void
}) {
  const text = useSuperAgentText()
  const { pendingPermissions, pendingCredentials, onRespondToPermission, onRespondToCredential } = useAppShellContext()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const pendingRef = useRef(false)
  const nodeId = snapshot.state.nodes.find(node => node.sessionId === sessionId)?.nodeId
    ?? snapshot.state.tasks.find(task => task.sessionId === sessionId)?.nodeId
  const node = snapshot.config.nodes.find(node => node.id === nodeId)
  const inbox = snapshot.permissionRequests ?? []
  const approvals = inbox.filter(request => request.sessionId === sessionId && request.status === 'pending')
  const ordinary = ordinaryPermissionHeads(new Set([sessionId]), pendingPermissions, inbox)
  const credential = pendingCredentials.get(sessionId)?.[0]
  async function run(action: () => unknown | Promise<unknown>) {
    if (busy || pendingRef.current) return
    pendingRef.current = true
    setPending(true); setError('')
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { pendingRef.current = false; setPending(false) }
  }

  return <SessionDetailsDialog sessionId={sessionId} title={node?.name ?? text('openSession')}
    description={text('openSession')} onClose={onClose}>
    {(approvals.length > 0 || ordinary.length > 0 || credential || error) && <div className="max-h-[40%] shrink-0 space-y-3 overflow-y-auto" aria-label={text('permissionInbox')}>
      {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {approvals.map(request => <ApprovalCard key={request.id} owner={node?.name ?? request.nodeId}
        request={request} pending={busy || pending}
        onRespond={allowed => { void run(() => onCommand({ type: 'permission-response', requestId: request.id, allowed })) }}
        onRemember={node?.role === 'worker' && canShareSuperAgentPermission(request.scope)
          ? () => { void run(() => onCommand({ type: 'permission-response', requestId: request.id, allowed: true, remember: true })) } : undefined} />)}
      {ordinary.map(request => <ApprovalCard key={request.requestId} owner={node?.name ?? nodeId ?? text('openSession')}
        request={request} pending={busy || pending || !onRespondToPermission}
        onRespond={allowed => { void run(() => onRespondToPermission?.(sessionId, request.requestId, allowed, false)) }} />)}
      {credential && <fieldset disabled={busy || pending || !onRespondToCredential} className="min-w-0">
        <CredentialRequest key={credential.requestId} request={credential}
          onResponse={response => { void run(() => onRespondToCredential?.(sessionId, credential.requestId, response)) }} />
      </fieldset>}
    </div>}
  </SessionDetailsDialog>
}

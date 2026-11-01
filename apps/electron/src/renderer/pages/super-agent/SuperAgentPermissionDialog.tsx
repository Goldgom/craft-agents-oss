import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { useAppShellContext } from '@/context/AppShellContext'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ApprovalCard } from './SuperAgentConversation'
import { useSuperAgentText } from './super-agent-ui'

/** Mounted in AppShell so background nodes can ask even when their page is closed. */
export function SuperAgentPermissionDialog() {
  const text = useSuperAgentText()
  const { pendingPermissions, onRespondToPermission } = useAppShellContext()
  const sessionMeta = useAtomValue(sessionMetaMapAtom)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [handled, setHandled] = useState<Set<string>>(() => new Set())
  const request = [...pendingPermissions.values()].map(requests => requests[0])
    .find(request => request && !handled.has(request.sessionId + ':' + request.requestId))
  if (!request) return null
  async function respond(allowed: boolean) {
    if (pending || !request || !onRespondToPermission) return
    setPending(true); setError('')
    try {
      await onRespondToPermission(request.sessionId, request.requestId, allowed, false)
      setHandled(previous => new Set(previous).add(request.sessionId + ':' + request.requestId))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  return <Dialog open onOpenChange={open => {
    // Closing only dismisses this notice. The operation remains waiting in its
    // session/inbox, allowing the user to change modes or stop the work.
    if (!open && !pending) setHandled(previous => new Set(previous).add(request.sessionId + ':' + request.requestId))
  }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" onInteractOutside={event => { if (pending) event.preventDefault() }} onEscapeKeyDown={event => { if (pending) event.preventDefault() }}>
    <DialogHeader><DialogTitle>{text('permissionInbox')}</DialogTitle><DialogDescription>{text('waitingPermission')}</DialogDescription></DialogHeader>
    <ApprovalCard owner={sessionMeta.get(request.sessionId)?.name ?? text('worker')} request={request}
      pending={pending || !onRespondToPermission} onRespond={allowed => { void respond(allowed) }} />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </DialogContent></Dialog>
}

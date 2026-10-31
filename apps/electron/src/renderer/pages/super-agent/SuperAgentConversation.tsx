import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowUp, ChevronDown, Circle, LoaderCircle, Paperclip, X, ShieldCheck, Sparkles, Square } from 'lucide-react'
import { canShareSuperAgentPermission, type SuperAgentCommand, type SuperAgentConfig, type SuperAgentSnapshot } from '@tokenbird/shared/super-agent'
import type { FileAttachment, PermissionRequest } from '../../../shared/types'
import { useAppShellContext } from '@/context/AppShellContext'
import { Button } from '@/components/ui/button'
import { BirdAvatar } from '@/components/bird/BirdAvatar'
import { Markdown } from '@/components/markdown'
import { cn } from '@/lib/utils'
import { AgentAvatar } from './SuperAgentForms'
import { SuperAgentThinkingIndicator } from './SuperAgentThinkingIndicator'
import { superAgentThinkingPhase } from './super-agent-thinking'
import { nodeLabel } from './SuperAgentCollaboration'
import { formatTimestamp, useSuperAgentText } from './super-agent-ui'
import { conversationMessages, ordinaryPermissionHeads, recentPermissionResolutions, visibleActivityText, type SuperAgentApproval } from './super-agent-activity'
import { approvalNotice, permissionNotice } from './super-agent-permission-notice'
import { PermissionResultCard } from './PermissionResultCard'
import { SuperAgentBlockingCard } from './SuperAgentBlockingCard'
import { SuperAgentDeliveryCard } from './SuperAgentDeliveryCard'
import { superAgentBlockingReports, type SuperAgentBlockingReport } from './super-agent-blockers'

export function SuperAgentConversation({ snapshot, active, busy, requestPending, canStop, onStop, onCommand, onInspect }: {
  snapshot: SuperAgentSnapshot & { config: SuperAgentConfig }
  active: boolean
  busy: boolean
  requestPending: boolean
  canStop: boolean
  onStop: () => void
  onCommand: (command: SuperAgentCommand) => Promise<void>
  onInspect: () => Promise<void>
}) {
  const text = useSuperAgentText()
  const { pendingPermissions, onRespondToPermission } = useAppShellContext()
  const { config, state } = snapshot
  const coordinator = config.nodes.find(node => node.role === 'coordinator')!
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [picking, setPicking] = useState(false)
  const [sending, setSending] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const inspectRef = useRef(false)
  const [respondingTo, setRespondingTo] = useState<string | null>(null)
  const [approvalError, setApprovalError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const approvalRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const messages = conversationMessages(state.messages)
  const inbox = snapshot.permissionRequests ?? []
  const notices = new Map(messages.map(message => [message.id, permissionNotice(message, inbox, config)]))
  const approvals = inbox.filter(request => request.status === 'pending')
  const sessionIds = new Set(state.nodes.map(node => node.sessionId).filter((id): id is string => !!id))
  const ordinary = ordinaryPermissionHeads(sessionIds, pendingPermissions, inbox)
  const approvalCount = approvals.length + ordinary.length
  const coordinatorRuntime = state.nodes.find(node => node.nodeId === coordinator.id)
  const coordinatorSession = coordinatorRuntime?.sessionId
  const coordinatorWaiting = approvals.some(request => request.nodeId === coordinator.id)
    || ordinary.some(request => request.sessionId === coordinatorSession)
    || (coordinatorRuntime?.status === 'working' && snapshot.activity?.some(item => item.nodeId === coordinator.id && item.sessionId === coordinatorSession && item.status === 'waiting_permission'))
  const thinkingPhase = superAgentThinkingPhase(snapshot, sending, coordinatorWaiting)
  const blockingReports = superAgentBlockingReports(state)
  const humanReports = blockingReports.filter(report => report.kind === 'user' && report.requiresUserAction)
  const inspectionPending = inspecting || snapshot.inspectionPending === true
  function provideInput(report: SuperAgentBlockingReport) {
    setInput(current => current || text('blockerReplyPrompt', { title: report.title, action: report.userAction ?? '' }))
    inputRef.current?.focus()
    inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  function replyToDelivery(title: string) {
    setInput(current => current || text('deliveryReplyPrompt', { title }))
    inputRef.current?.focus()
    inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  useEffect(() => {
    if (active && followRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages.length, approvalCount, busy, active, thinkingPhase])

  async function send() {
    if ((!input.trim() && !attachments.length) || picking || requestPending || sending || !snapshot.environment.available) return
    const draft = input
    setSending(true)
    try { await onCommand({ type: 'chat', text: draft.trim() || '请处理附件 / Please process the attachments', attachments: attachments.map(({ name, mimeType, text, base64 }) => ({ name, mimeType, text, base64 })) }); setAttachments([]); setInput(current => current === draft ? '' : current) } catch { /* The page keeps the draft and displays the actual backend error. */ } finally { setSending(false) }
  }
  async function pickAttachments() {
    setPicking(true); setAttachmentError('')
    try {
      const paths = await window.electronAPI.openFileDialog()
      const files = await Promise.all(paths.map(path => window.electronAPI.readFileAttachment(path)))
      if (files.some(file => !file)) throw new Error('Unable to read one of the selected attachments')
      const next = [...attachments, ...files.filter((file): file is FileAttachment => !!file)]
      if (next.length > 10 || next.reduce((size, file) => size + file.size, 0) > 20_000_000) throw new Error('最多 10 个附件，总大小不超过 20 MB / Up to 10 files, 20 MB total')
      setAttachments(next)
    } catch (error) { setAttachmentError(error instanceof Error ? error.message : String(error)) }
    finally { setPicking(false) }
  }
  async function inspect() {
    if (inspectRef.current || snapshot.inspectionPending || requestPending || !snapshot.environment.available) return
    inspectRef.current = true; setInspecting(true)
    try { await onInspect() } catch { /* The page displays the actual backend error. */ }
    finally { inspectRef.current = false; setInspecting(false) }
  }
  async function respond(request: SuperAgentApproval, allowed: boolean, remember = false) {
    if (respondingTo) return
    setRespondingTo(request.id); setApprovalError('')
    try { await onCommand({ type: 'permission-response', requestId: request.id, allowed, ...(remember ? { remember: true } : {}) }) }
    catch (cause) { setApprovalError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setRespondingTo(null) }
  }
  async function respondOrdinary(request: PermissionRequest, allowed: boolean) {
    if (!onRespondToPermission || respondingTo) return
    setRespondingTo(request.requestId); setApprovalError('')
    try { await onRespondToPermission(request.sessionId, request.requestId, allowed, false) }
    catch (cause) { setApprovalError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setRespondingTo(null) }
  }

  return <section aria-label={text('conversation')} aria-busy={!!thinkingPhase} className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-3">
      <div className="flex min-w-0 items-center gap-2"><div aria-hidden="true" className="h-10 w-12 shrink-0">
        <BirdAvatar paused={!active} state={{
          mood: coordinatorWaiting ? 'waiting' : coordinatorRuntime?.status === 'error' ? 'error'
            : thinkingPhase === 'mainReplying' ? 'working' : thinkingPhase ? 'thinking' : 'idle',
          activity: thinkingPhase === 'mainReplying' ? 'greeting' : 'idle',
        }} />
      </div>
        <div className="min-w-0"><p className="truncate text-xs font-medium">{coordinator.name}</p><p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">{thinkingPhase ? <LoaderCircle aria-hidden="true" className="size-3 text-primary motion-safe:animate-spin" /> : <Circle aria-hidden="true" className="size-1.5 fill-current text-emerald-500" />}<span className="truncate">{coordinator.model}</span></p></div>
      </div>
      {canStop ? <Button size="sm" variant="ghost" onClick={onStop}><Square className="size-3.5" />{text('stopAll')}</Button>
        : <Button size="sm" variant="ghost" disabled={inspectionPending || requestPending || !snapshot.environment.available} onClick={() => void inspect()}>{inspectionPending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}{text('inspect')}</Button>}
    </div>
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5" onScroll={() => {
      const scroller = scrollRef.current
      if (scroller) followRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100
    }}>
      <div className="mx-auto w-full max-w-6xl space-y-6">
        {!thinkingPhase && !messages.some(message => !notices.get(message.id)) && <div className="mx-auto flex max-w-sm flex-col items-center gap-4 py-12 text-center"><AgentAvatar avatar={config.avatar} name={config.name} className="size-16 rounded-3xl text-3xl" /><h1 className="text-lg font-semibold">{config.name}</h1><p className="text-sm leading-6 text-muted-foreground">{text('introMessage')}</p></div>}
        {messages.map(message => {
          if (notices.get(message.id)) return null
          const user = message.fromNodeId === 'user'
          const sender = config.nodes.find(node => node.id === message.fromNodeId) ?? coordinator
          const errorSummary = message.kind === 'error' ? text(
            message.body.includes('"status":"partially_applied"') ? 'conversationErrorPartial'
              : /Shared board changed|Plan .+ changed \(revision|revision conflict/i.test(message.body) ? 'conversationErrorConflict'
                : /JSON|super_agent_actions|validation error/i.test(message.body) ? 'conversationErrorFormat'
                  : 'conversationErrorGeneral') : undefined
          return <article key={message.id} className={cn('flex items-start gap-3', user && 'flex-row-reverse')}>
            {!user && <AgentAvatar avatar={sender.avatar} name={sender.name} className="mt-0.5 size-8 rounded-lg text-base" />}
            <div className={cn('min-w-0', user ? 'max-w-[88%] rounded-2xl bg-foreground/5 px-4 py-3' : 'flex-1')}>
              {!user && <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground"><span className="font-medium">{nodeLabel(config, message.fromNodeId, text)}</span><span>{formatTimestamp(message.createdAt)}</span></div>}
              {errorSummary ? <details className="group min-w-0 rounded-2xl border border-destructive/25 bg-destructive/10 text-destructive">
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-2xl px-4 py-3 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-destructive/50 [&::-webkit-details-marker]:hidden">
                  <AlertCircle aria-hidden="true" className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 break-words">{errorSummary}</span>
                  <span className="shrink-0 text-xs">{text('conversationErrorDetails')}</span>
                  <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t border-destructive/15 px-4 py-3">
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5">{message.body}</pre>
                </div>
              </details> : !user && message.delivery ? <SuperAgentDeliveryCard delivery={message.delivery} body={visibleActivityText(message.body)} artifacts={state.artifacts ?? []} text={text}
                disabled={requestPending || sending || !snapshot.environment.available} onReply={replyToDelivery} />
                : <div className="break-words text-sm leading-6">{user ? <p className="whitespace-pre-wrap">{message.body}</p> : <Markdown>{visibleActivityText(message.body)}</Markdown>}</div>}
            </div>
          </article>
        })}
        <SuperAgentThinkingIndicator phase={thinkingPhase} avatar={coordinator.avatar} name={coordinator.name} text={text} />
        {humanReports.length > 0 && <aside role="status" className="space-y-3 rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4 text-sm">
          <h2 className="font-medium text-amber-700 dark:text-amber-400">{text('queueBlocked')}</h2>
          <div className="space-y-3">{humanReports.map(report => <SuperAgentBlockingCard key={report.id} report={report} text={text} processing={false}
            disabled={requestPending} onProvideInput={provideInput} />)}</div>
        </aside>}
        {approvalCount > 0 && <div ref={approvalRef} className="space-y-3" aria-label={text('permissionInbox')}>
          <h2 className="flex items-center gap-2 text-xs font-semibold"><ShieldCheck className="size-3.5 text-amber-600 dark:text-amber-400" />{text('permissionInbox')}<span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">{approvalCount}</span></h2>
          {approvals.map(request => <ApprovalCard key={request.sessionId + ':' + request.id} owner={nodeLabel(config, request.nodeId, text)} request={request}
            pending={respondingTo !== null || requestPending} onRespond={allowed => { void respond(request, allowed) }}
            onRemember={canShareSuperAgentPermission(request.scope) && config.nodes.find(node => node.id === request.nodeId)?.role === 'worker' ? () => { void respond(request, true, true) } : undefined} />)}
          {ordinary.map(request => <ApprovalCard key={request.sessionId + ':' + request.requestId} owner={nodeLabel(config, state.nodes.find(node => node.sessionId === request.sessionId)?.nodeId ?? coordinator.id, text)} request={request}
            pending={respondingTo !== null || !onRespondToPermission} onRespond={allowed => { void respondOrdinary(request, allowed) }} />)}
        </div>}
        {approvalError && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs leading-5 text-destructive">{approvalError}</p>}
      </div>
    </div>
    <div className="shrink-0 px-5 pb-5 pt-3">
      <div className="mx-auto w-full max-w-6xl space-y-2">
        {approvalCount > 0 && <button type="button" className="flex items-center gap-2 text-xs text-amber-700 hover:underline dark:text-amber-400" onClick={() => approvalRef.current?.scrollIntoView({ block: 'nearest' })}><ShieldCheck className="size-3.5" />{text('approvalCount', { count: approvalCount })}<ChevronDown className="size-3" /></button>}
        <div className="rounded-2xl border border-border bg-background p-3 shadow-xs">
          {attachmentError && <p role="alert" className="text-xs text-destructive">{attachmentError}</p>}
          <div className="flex flex-wrap gap-2">{attachments.map((file, index) => <button key={`${file.name}-${index}`} type="button" disabled={sending} className="flex items-center gap-1 rounded border px-2 py-1 text-xs" onClick={() => setAttachments(current => current.filter((_, i) => i !== index))}>{file.name}<X className="size-3" /></button>)}</div>
          <textarea ref={inputRef} rows={2} maxLength={32_000} className="max-h-40 min-h-14 w-full resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground/70" value={input} placeholder={text('messagePlaceholder')} aria-label={text('messagePlaceholder')}
            onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
          <div className="mt-2 flex items-center justify-between gap-3"><span className="truncate text-[10px] text-muted-foreground">{busy ? text('sendWhileWorking') : text('coordinator')}</span>
            <div className="flex gap-2"><Button size="icon" variant="ghost" aria-label="添加附件 / Attach files" disabled={sending || picking} onClick={() => void pickAttachments()}>{picking ? <LoaderCircle className="size-4 animate-spin" /> : <Paperclip className="size-4" />}</Button><Button size="icon" className="size-8 shrink-0 rounded-xl" aria-label={text('send')} disabled={(!input.trim() && !attachments.length) || picking || requestPending || sending || !snapshot.environment.available} onClick={() => void send()}>{sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</Button></div></div>
        </div>
      </div>
    </div>
  </section>
}

export function SuperAgentPermissionHistory({ snapshot, className }: {
  snapshot: SuperAgentSnapshot & { config: SuperAgentConfig }
  className?: string
}) {
  const text = useSuperAgentText()
  const { config, state } = snapshot
  const inbox = snapshot.permissionRequests ?? []
  const notices = state.messages.flatMap(message => {
    const notice = permissionNotice(message, inbox, config)
    return notice && notice.record.status !== 'pending' ? [{ notice, timestamp: notice.record.resolvedAt ?? message.createdAt }] : []
  })
  const representedApprovals = new Set(notices.map(({ notice }) => notice.record.id))
  const resolutions = recentPermissionResolutions(inbox.filter(request => !representedApprovals.has(request.id)))
  const records = [...notices, ...resolutions.map(request => ({ notice: approvalNotice(request), timestamp: request.resolvedAt ?? request.createdAt }))]
  const history = [...new Map(records.map(item => [item.notice.record.id, item])).values()].sort((a, b) => b.timestamp - a.timestamp)
  if (!history.length) return null
  return <section className={cn('flex min-h-0 flex-col gap-3 border-t border-border/60 pt-4', className)} aria-label={text('permissionHistory')}>
    <h2 className="shrink-0 text-[11px] font-medium text-muted-foreground">{text('permissionHistory')}</h2>
    <div className="min-h-0 space-y-2 overflow-y-auto" aria-live="polite">{history.map(({ notice, timestamp }) => <PermissionResultCard key={notice.record.id}
      notice={notice} owner={notice.owner ?? nodeLabel(config, notice.record.nodeId, text)} timestamp={formatTimestamp(timestamp)} text={text} />)}</div>
  </section>
}

export function ApprovalCard({ owner, request, pending, onRespond, onRemember }: {
  owner: string
  request: SuperAgentApproval | PermissionRequest
  pending: boolean
  onRespond: (allowed: boolean) => void
  onRemember?: () => void
}) {
  const text = useSuperAgentText()
  const scope = 'scope' in request ? request.scope : 'policyScope' in request ? request.policyScope : undefined
  const exactGrant = !!scope
  return <article className="space-y-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
    <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" /><div className="min-w-0 flex-1"><h3 className="text-sm font-medium">{text('approvalOwner', { name: owner })}</h3><p className="mt-1 text-xs leading-5 text-foreground/80">{request.description}</p></div></div>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs"><dt className="text-muted-foreground">{text('toolActivity')}</dt><dd className="break-all">{request.toolName}</dd>
      {scope && <><dt className="text-muted-foreground">{text('approvalTarget')}</dt><dd className="break-all font-mono text-[11px]">{scope.target}</dd>
        <dt className="text-muted-foreground">{text('approvalOperation')}</dt><dd className="max-h-24 overflow-auto break-all font-mono text-[11px]">{scope.operation}</dd>
        <dt className="text-muted-foreground">{text('approvalScope')}</dt><dd className={scope.boundary === 'outside-environment' || scope.boundary === 'host' ? 'text-amber-700 dark:text-amber-400' : ''}>{text(scope.boundary === 'outside-environment' ? 'outsideEnvironment' : scope.boundary === 'host' ? 'hostOperation' : scope.boundary === 'client' ? 'clientOperation' : scope.boundary === 'source' ? 'sourceOperation' : 'environmentOperation')}</dd></>}
    </dl>
    {request.reason && <p className="text-xs leading-5 text-muted-foreground">{request.reason}</p>}
    {request.command && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background/80 p-3 font-mono text-[11px] leading-5">{request.command}</pre>}
    {exactGrant && <p className="text-[11px] leading-5 text-muted-foreground">{text(scope?.actionGate ? 'actionGateApprovalHint' : 'exactApprovalHint')}</p>}
    {onRemember && <p className="text-[11px] leading-5 text-muted-foreground">{text('sharedApprovalHint')}</p>}
    <div className="flex flex-wrap justify-end gap-2"><Button size="sm" variant="outline" disabled={pending} onClick={() => onRespond(false)}>{text('deny')}</Button>
      {onRemember && <Button size="sm" variant="outline" disabled={pending} onClick={onRemember}>{text('approveForTeam')}</Button>}
      <Button size="sm" disabled={pending} onClick={() => onRespond(true)}>{pending && <LoaderCircle className="size-3.5 animate-spin" />}{text(scope?.actionGate ? 'approveInvocation' : exactGrant ? 'approveThisTurn' : 'allowOnce')}</Button></div>
  </article>
}

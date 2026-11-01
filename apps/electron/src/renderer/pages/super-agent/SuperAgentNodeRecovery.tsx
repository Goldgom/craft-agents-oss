import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle, RefreshCw, Trash2 } from 'lucide-react'
import type { SuperAgentCommand, SuperAgentNodeRuntime } from '@tokenbird/shared/super-agent'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatTimestamp, useSuperAgentText } from './super-agent-ui'

export function SuperAgentNodeRecovery({ runtime, nodeName, busy, onCommand }: {
  runtime: SuperAgentNodeRuntime
  nodeName?: string
  busy: boolean
  onCommand: (command: SuperAgentCommand) => Promise<void>
}) {
  const text = useSuperAgentText()
  const { i18n } = useTranslation()
  const tr = (zh: string, en: string) => i18n.language.startsWith('zh') ? zh : en
  const [resetOpen, setResetOpen] = useState(false)
  const [resetPending, setResetPending] = useState(false)
  const [resetError, setResetError] = useState('')
  const disabled = busy || resetPending
  async function reset() {
    if (disabled) return
    setResetPending(true); setResetError('')
    try {
      await onCommand({ type: 'node-reset', nodeId: runtime.nodeId, confirmed: true })
      setResetOpen(false)
    } catch (cause) { setResetError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setResetPending(false) }
  }
  const preparation = runtime.preparation?.status !== 'completed' ? runtime.preparation : undefined
  const stageLabels = { environment: tr('环境', 'Environment'), session: tr('会话', 'Session'), policy: tr('执行策略', 'Execution policy'), settings: tr('会话设置', 'Session settings'), ready: tr('启动检查', 'Readiness') }
  async function recover() {
    if (disabled) return
    setResetPending(true); setResetError('')
    try { await onCommand({ type: 'node-recover', nodeId: runtime.nodeId }) }
    catch (cause) { setResetError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setResetPending(false) }
  }
  if (!['preparing', 'error', 'recovering'].includes(runtime.status)) return null
  return <div className="space-y-2 text-xs leading-5">
    {preparation && <div role="status" className="space-y-1 text-muted-foreground">
      <p>{tr('准备阶段', 'Preparation stage')}: {stageLabels[preparation.stage]} · {tr('第', 'Attempt')} {preparation.attempt} {tr('次', '')}</p>
      <p>{tr('开始', 'Started')}: {formatTimestamp(preparation.startedAt, true)} · {tr('超时', 'Deadline')}: {formatTimestamp(preparation.deadlineAt, true)}</p>
      <p>{tr('耗时', 'Elapsed')}: {Math.max(0, Math.floor(((preparation.completedAt ?? Date.now()) - preparation.startedAt) / 1000))}s</p>
      {preparation.cleanupPending && <p className="text-amber-600 dark:text-amber-400">{tr('等待旧操作或运行时清理结束，暂不启动第二次准备。', 'Waiting for the old operation or runtime cleanup before another attempt.')}</p>}
      {preparation.error && <p className="break-words text-destructive">{preparation.error}</p>}
      <Button size="sm" variant="outline" disabled={disabled || preparation.cleanupPending || preparation.status === 'cancelling'} onClick={() => void recover()}>
        <RefreshCw className="size-3.5" />{preparation.status === 'preparing' ? tr('取消本次准备', 'Cancel preparation') : tr('重试准备', 'Retry preparation')}
      </Button>
    </div>}
    {resetError && !resetOpen && <p role="alert" className="break-words text-destructive">{resetError}</p>}
    {runtime.status === 'recovering' && <div role="status" className="text-amber-600 dark:text-amber-400">
      <p>{text('recoveryNotice', { attempt: Math.max(1, runtime.retryAttempt ?? 1) })}</p>
      {runtime.retryAt != null && <p>{text('recoveryNext', { time: formatTimestamp(runtime.retryAt, true) })}</p>}
      {runtime.retryDeadline != null && <p>{text('recoveryDeadline', { time: formatTimestamp(runtime.retryDeadline, true) })}</p>}
    </div>}
    {runtime.status !== 'preparing' && <><p className="text-[11px] text-muted-foreground">{text('nodeRefreshHint')}</p>
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={disabled || preparation?.cleanupPending} onClick={() => { void onCommand({ type: 'node-refresh', nodeId: runtime.nodeId }).catch(cause => setResetError(String(cause))) }}>
      <RefreshCw className="size-3.5" />{text(runtime.status === 'recovering' ? 'retryNodeNow' : 'refreshNode')}
    </Button>
      <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" disabled={disabled || preparation?.cleanupPending} onClick={() => { setResetError(''); setResetOpen(true) }}>
        <Trash2 className="size-3.5" />{text('resetNode')}
      </Button>
    </div></>}
    <Dialog open={resetOpen} onOpenChange={open => { if (!resetPending) setResetOpen(open) }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{text('resetNodeConfirm', { name: nodeName ?? runtime.nodeId })}</DialogTitle><DialogDescription>{text('resetNodeDescription')}</DialogDescription></DialogHeader>
        <p className="text-sm text-muted-foreground">{text('resetNodePreserved')}</p>
        {resetError && <p role="alert" className="break-words text-sm text-destructive">{resetError}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={resetPending} onClick={() => setResetOpen(false)}>{text('cancel')}</Button>
          <Button variant="destructive" disabled={disabled} onClick={() => void reset()}>{resetPending ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}{text(resetPending ? 'resettingNode' : 'resetNode')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}

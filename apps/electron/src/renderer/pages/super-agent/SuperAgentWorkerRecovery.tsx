import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import type { SuperAgentCommand, SuperAgentRecoverySummary } from '@tokenbird/shared/super-agent'
import { Button } from '@/components/ui/button'

export function SuperAgentWorkerRecovery({ recovery, busy, suspended, onCommand }: {
  recovery?: SuperAgentRecoverySummary
  busy: boolean
  suspended?: boolean
  onCommand: (command: SuperAgentCommand) => Promise<unknown>
}) {
  const { i18n } = useTranslation()
  const tr = (zh: string, en: string) => i18n.language.startsWith('zh') ? zh : en
  const pending = useRef(false)
  const working = !!recovery && recovery.phase !== 'ready' && recovery.phase !== 'blocked'
  const labels = {
    stopping: tr('正在结束旧执行节点', 'Stopping previous workers'),
    reconciling: tr('正在核对任务与执行结果', 'Reconciling tasks and results'),
    ready: tr('执行节点已重建，任务进度已保留', 'Workers rebuilt; task progress preserved'),
    blocked: tr('恢复等待处理', 'Recovery needs attention'),
  }
  async function recover() {
    if (pending.current || busy || working) return
    pending.current = true
    try {
      await onCommand({ type: 'recover-workers', requestId: recovery?.phase === 'blocked' ? recovery.id : `recovery_${crypto.randomUUID().replaceAll('-', '')}` })
    } catch { /* The page mutation handler displays the actual failure. */ }
    finally { pending.current = false }
  }
  return <div className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-2 text-xs">
    <div role="status" className="min-w-0 space-y-1 text-muted-foreground">
      <p>{suspended ? tr('任务已停止，恢复不会自动派发工作', 'Work is stopped; recovery will not dispatch tasks')
        : recovery ? labels[recovery.phase] : tr('恢复时保留主要节点进度、通信和任务板，重建执行子节点。', 'Recovery preserves management progress, messages and the board, and rebuilds execution workers.')}</p>
      {recovery?.error && <p className="break-words text-amber-600 dark:text-amber-400">{recovery.error}</p>}
      {!!recovery?.unresolvedOperationIds.length && <p>{tr(`${recovery.unresolvedOperationIds.length} 项操作待核验，相关资源暂缓接管。`, `${recovery.unresolvedOperationIds.length} operations need verification before their resources can be reassigned.`)}</p>}
    </div>
    <Button size="sm" variant="outline" disabled={busy || working || suspended} onClick={() => void recover()}>
      <RefreshCw className={working ? 'size-3.5 animate-spin' : 'size-3.5'} />{tr('恢复任务', 'Recover tasks')}
    </Button>
  </div>
}

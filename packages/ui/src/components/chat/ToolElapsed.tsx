import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from './turn-utils'

/** Keep live clock updates local to running rows instead of rerendering the chat. */
export function ToolElapsed({ startedAt }: { startedAt: number }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const elapsed = Math.max(0, now - startedAt)
  return (
    <span className="shrink-0 text-[10px] tabular-nums" title={t('activity.runningHint')}>
      {formatDuration(elapsed)}
      {elapsed >= 30_000 && <span className="ml-1">{t('activity.stillRunning')}</span>}
    </span>
  )
}

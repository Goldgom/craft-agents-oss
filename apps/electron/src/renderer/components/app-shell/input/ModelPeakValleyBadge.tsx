import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { LlmConnection } from '@config/llm-connections'
import { EntityListBadge } from '@/components/ui/entity-list-badge'
import { getPeakValleyPeriod, getPricingSnapshot, subscribePricing, supportsTokenNestPricing } from '@/lib/tokennest-pricing'

export function ModelPeakValleyBadge(props: { connection?: LlmConnection | null; modelId: string }) {
  if (!supportsTokenNestPricing(props.connection, props.modelId)) return null
  return <TokenNestPeakValleyBadge modelId={props.modelId.replace(/^pi\//, '')} />
}

function TokenNestPeakValleyBadge(props: { modelId: string }) {
  const { t } = useTranslation()
  const pricing = useSyncExternalStore(subscribePricing, getPricingSnapshot, getPricingSnapshot)
  const schedule = pricing.schedules[props.modelId]
  if (!schedule) return null
  const offPeak = getPeakValleyPeriod(schedule, pricing.at) === 'off-peak'
  return (
    <EntityListBadge
      className="inline-flex"
      colorClass={offPeak ? 'bg-success/10 text-success' : 'bg-info/10 text-info'}
      tooltip={t('chat.modelPicker.peakValleySchedule', { ...schedule })}
    >
      {offPeak ? t('chat.modelPicker.offPeak') : t('chat.modelPicker.peak')}
    </EntityListBadge>
  )
}

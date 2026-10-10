import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { LlmConnection } from '@config/llm-connections'
import { EntityListBadge } from '@/components/ui/entity-list-badge'
import { getPeakValleyPeriod, getPricingSnapshot, getDeepSeekPricingSnapshot, subscribePricing, subscribeDeepSeekPricing, getModelPricingSource, type PricingSource } from '@/lib/tokennest-pricing'

export function ModelPeakValleyBadge(props: { connection?: LlmConnection | null; modelId: string }) {
  const source = getModelPricingSource(props.connection, props.modelId)
  if (!source) return null
  return <ProviderPeakValleyBadge source={source} modelId={props.modelId.replace(/^pi\//, '')} />
}

function ProviderPeakValleyBadge(props: { source: PricingSource; modelId: string }) {
  const { t } = useTranslation()
  const subscribe = props.source === 'deepseek' ? subscribeDeepSeekPricing : subscribePricing
  const getSnapshot = props.source === 'deepseek' ? getDeepSeekPricingSnapshot : getPricingSnapshot
  const pricing = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const schedule = pricing.schedules[props.modelId]
  if (!schedule) return null
  const offPeak = getPeakValleyPeriod(schedule, pricing.at) === 'off-peak'
  return (
    <EntityListBadge
      className="inline-flex"
      colorClass={offPeak ? 'bg-success/10 text-success' : 'bg-info/10 text-info'}
      tooltip={schedule.mode === 'china_business_hours'
        ? t('chat.modelPicker.deepSeekPeakValleySchedule')
        : t('chat.modelPicker.peakValleySchedule', { ...schedule })}
    >
      {offPeak ? t('chat.modelPicker.offPeak') : t('chat.modelPicker.peak')}
    </EntityListBadge>
  )
}

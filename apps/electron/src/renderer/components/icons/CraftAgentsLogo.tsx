import { useTranslation } from 'react-i18next'
import { getLocalizedProductName } from '@craft-agent/shared/branding'

interface CraftAgentsLogoProps {
  className?: string
}

/**
 * TokenBird wordmark. The legacy component name is kept to avoid breaking
 * imports and persisted playground references.
 */
export function CraftAgentsLogo({ className }: CraftAgentsLogoProps) {
  const { i18n } = useTranslation()
  const productName = getLocalizedProductName(i18n.resolvedLanguage ?? i18n.language)

  return (
    <svg
      viewBox="0 0 320 72"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <text x="0" y="54" fill="currentColor" fontFamily="ui-sans-serif, system-ui, sans-serif" fontSize="54" fontWeight="700" letterSpacing={productName === '词元鸟' ? '1' : '-2'}>
        {productName}
      </text>
    </svg>
  )
}

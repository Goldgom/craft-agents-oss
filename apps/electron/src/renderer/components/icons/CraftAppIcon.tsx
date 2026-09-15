import tokenBirdIcon from '@/assets/branding/tokenbird.png'
import { useTranslation } from 'react-i18next'
import { getLocalizedProductName } from '@craft-agent/shared/branding'

interface CraftAppIconProps {
  className?: string
  size?: number
}

/**
 * CraftAppIcon - Displays the TokenBird application icon.
 */
export function CraftAppIcon({ className, size = 64 }: CraftAppIconProps) {
  const { i18n } = useTranslation()
  return (
    <img
      src={tokenBirdIcon}
      alt={getLocalizedProductName(i18n.resolvedLanguage ?? i18n.language)}
      width={size}
      height={size}
      className={className}
    />
  )
}

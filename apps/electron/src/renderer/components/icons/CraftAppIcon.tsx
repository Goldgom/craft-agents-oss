import tokenBirdIcon from '@/assets/branding/tokenbird.png'

interface CraftAppIconProps {
  className?: string
  size?: number
}

/**
 * CraftAppIcon - Displays the TokenBird application icon.
 */
export function CraftAppIcon({ className, size = 64 }: CraftAppIconProps) {
  return (
    <img
      src={tokenBirdIcon}
      alt="TokenBird"
      width={size}
      height={size}
      className={className}
    />
  )
}

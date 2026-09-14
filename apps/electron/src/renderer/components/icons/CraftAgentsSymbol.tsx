import tokenBirdIcon from '@/assets/branding/tokenbird.png'

interface CraftAgentsSymbolProps {
  className?: string
}

/**
 * TokenBird symbol. The legacy component name is kept for import compatibility.
 */
export function CraftAgentsSymbol({ className }: CraftAgentsSymbolProps) {
  return (
    <img
      src={tokenBirdIcon}
      alt=""
      className={className}
    />
  )
}

interface CraftAgentsSymbolProps {
  className?: string
}

/**
 * TokenBird symbol. The legacy component name is kept for import compatibility.
 */
export function CraftAgentsSymbol({ className }: CraftAgentsSymbolProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M16 7h.01M3.4 18H12a8 8 0 0 0 8-8V7l-3.3 2.2A6 6 0 0 1 7 12H4a4 4 0 0 0 4 4h1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 18v3m5-3 1.5 3M19 5l2 1-2 1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

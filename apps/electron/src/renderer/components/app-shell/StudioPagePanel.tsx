import * as React from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { useTranslation } from 'react-i18next'

type StudioPagePanelProps = {
  active: boolean
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
  display?: 'block' | 'flex'
}

/** Overlap pages while fading; keep editors mounted so their state survives switching. */
export const StudioPagePanel = React.forwardRef<HTMLDivElement, StudioPagePanelProps>(
  function StudioPagePanel({ active, children, className, style, display = 'block' }, ref) {
    const reduceMotion = useReducedMotion()

    return (
      <motion.div
        ref={ref}
        className={className}
        aria-hidden={!active}
        {...{ inert: active ? undefined : '' }}
        initial={active ? { opacity: 0 } : false}
        animate={active ? 'active' : 'inactive'}
        variants={{
          active: { display, opacity: 1 },
          inactive: { opacity: 0, transitionEnd: { display: 'none' } },
        }}
        transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
        style={{ ...style, gridArea: '1 / 1', minWidth: 0, minHeight: 0, pointerEvents: active ? undefined : 'none' }}
      >
        {children}
      </motion.div>
    )
  },
)

export function StudioPageLoading() {
  const { t } = useTranslation()
  return (
    <div role="status" className="flex h-full items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
      <span className="size-4 animate-spin rounded-full border-2 border-primary/20 border-t-primary motion-reduce:animate-none" aria-hidden="true" />
      {t('common.loading')}
    </div>
  )
}

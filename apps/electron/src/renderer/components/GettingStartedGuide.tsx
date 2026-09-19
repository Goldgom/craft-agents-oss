import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Clock3,
  Database,
  MessageSquare,
  Sparkles,
  WandSparkles,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type GuideIcon = ComponentType<{ className?: string }>

interface GettingStartedGuideProps {
  open: boolean
  onComplete: () => void
}

interface GuideCardProps {
  icon: GuideIcon
  title: string
  description: string
  className?: string
  children?: ReactNode
}

const GUIDE_STEP_COUNT = 3

function GuideCard({ icon: Icon, title, description, className, children }: GuideCardProps) {
  return (
    <section className={cn('rounded-xl border border-foreground/10 bg-foreground/[0.025] p-4', className)}>
      <div className="mb-3 flex size-9 items-center justify-center rounded-lg bg-foreground/[0.06]">
        <Icon className="size-[18px] text-foreground/75" />
      </div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1.5 text-xs leading-relaxed text-foreground/60">{description}</p>
      {children}
    </section>
  )
}

/**
 * One-time product education shown after the app reaches its ready state.
 * This is deliberately a dedicated full-viewport surface instead of the
 * shared centered DialogContent: there is no percentage positioning or
 * transform for older WebViews to partially apply.
 */
export function GettingStartedGuide({ open, onComplete }: GettingStartedGuideProps) {
  const { t } = useTranslation()
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (open) setStep(0)
  }, [open])

  useEffect(() => {
    if (!open) return

    const handleAndroidBack = (event: Event) => {
      event.preventDefault()
      if (step > 0) {
        setStep(current => Math.max(0, current - 1))
      } else {
        onComplete()
      }
    }

    window.addEventListener('craft-agent-android-back', handleAndroidBack)
    return () => window.removeEventListener('craft-agent-android-back', handleAndroidBack)
  }, [onComplete, open, step])

  const isLastStep = step === GUIDE_STEP_COUNT - 1

  return (
    <DialogPrimitive.Root open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-getting-started-guide
          className="fixed inset-0 grid w-full grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-background text-foreground outline-none"
          style={{
            zIndex: 'var(--z-fullscreen, 350)',
            height: 'var(--app-viewport-height, 100dvh)',
            maxHeight: 'var(--app-viewport-height, 100dvh)',
          }}
          onOpenAutoFocus={event => event.preventDefault()}
          onEscapeKeyDown={event => event.preventDefault()}
          onInteractOutside={event => event.preventDefault()}
          onPointerDownOutside={event => event.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">
            {t('gettingStarted.title')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {t('gettingStarted.description')}
          </DialogPrimitive.Description>

          <DialogPrimitive.Close
            className="absolute right-4 top-4 z-10 flex size-10 items-center justify-center rounded-full bg-foreground/[0.06] text-foreground/65 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('common.close')}
            onClick={onComplete}
          >
            <X className="size-5" />
          </DialogPrimitive.Close>

          <div data-getting-started-guide-scroll className="min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain">
            <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center px-5 pb-6 pt-16 sm:px-8 sm:pb-8 sm:pt-12">
              <header className="relative mx-auto w-full max-w-3xl text-left sm:text-center">
                <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/45 sm:justify-center">
                  <Sparkles className="size-3.5 text-accent" />
                  {t('gettingStarted.eyebrow')}
                </div>
                <h1 className="text-2xl font-semibold leading-tight sm:text-3xl">
                  {t('gettingStarted.title')}
                </h1>
                <p className="mt-3 text-sm leading-relaxed text-foreground/60">
                  {t('gettingStarted.description')}
                </p>
              </header>

              <div className="mx-auto mt-6 w-full max-w-3xl">
                {step === 0 && (
                  <GuideCard
                    icon={MessageSquare}
                    title={t('gettingStarted.create.title')}
                    description={t('gettingStarted.create.description')}
                  >
                    <div className="mt-3 rounded-lg border border-foreground/[0.08] bg-foreground/[0.035] px-3 py-2.5 text-xs italic leading-relaxed text-foreground/70">
                      “{t('gettingStarted.create.example')}”
                    </div>
                  </GuideCard>
                )}

                {step === 1 && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <GuideCard
                      icon={BookOpen}
                      title={t('gettingStarted.pages.title')}
                      description={t('gettingStarted.pages.description')}
                    />
                    <GuideCard
                      icon={Database}
                      title={t('gettingStarted.sources.title')}
                      description={t('gettingStarted.sources.description')}
                    />
                  </div>
                )}

                {step === 2 && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <GuideCard
                      icon={WandSparkles}
                      title={t('gettingStarted.skills.title')}
                      description={t('gettingStarted.skills.description')}
                    />
                    <GuideCard
                      icon={Clock3}
                      title={t('gettingStarted.automations.title')}
                      description={t('gettingStarted.automations.description')}
                    />
                    <GuideCard
                      icon={Sparkles}
                      title={t('gettingStarted.loop.title')}
                      description={t('gettingStarted.loop.description')}
                      className="border-accent/20 bg-accent/[0.07] sm:col-span-2"
                    >
                      <p className="mt-2 text-[11px] leading-relaxed text-foreground/45">
                        {t('gettingStarted.loop.safety')}
                      </p>
                    </GuideCard>
                  </div>
                )}
              </div>
            </div>
          </div>

          <footer
            className="border-t border-foreground/10 bg-background/95 px-5 pb-4 pt-3 backdrop-blur sm:px-8"
            style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}
          >
            <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
              <div className="flex flex-1 items-center gap-1.5" aria-label={`${step + 1} / ${GUIDE_STEP_COUNT}`}>
                {Array.from({ length: GUIDE_STEP_COUNT }, (_, index) => (
                  <span
                    key={index}
                    className={cn(
                      'h-1.5 rounded-full transition-all',
                      index === step ? 'w-6 bg-accent' : 'w-1.5 bg-foreground/15',
                    )}
                  />
                ))}
              </div>

              {step > 0 && (
                <Button variant="ghost" onClick={() => setStep(current => Math.max(0, current - 1))}>
                  <ArrowLeft className="size-4" />
                  {t('common.back')}
                </Button>
              )}

              <Button
                onClick={() => {
                  if (isLastStep) onComplete()
                  else setStep(current => Math.min(GUIDE_STEP_COUNT - 1, current + 1))
                }}
              >
                {isLastStep ? t('gettingStarted.start') : t('common.continue')}
                <ArrowRight className="size-4" />
              </Button>
            </div>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

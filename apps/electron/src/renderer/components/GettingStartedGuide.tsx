import type { ComponentType } from 'react'
import { ArrowRight, BookOpen, Clock3, Database, MessageSquare, Sparkles, WandSparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  children?: React.ReactNode
}

function GuideCard({ icon: Icon, title, description, className, children }: GuideCardProps) {
  return (
    <section className={cn('rounded-xl border border-foreground/10 bg-background/70 p-4', className)}>
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
 * Provider setup remains in OnboardingWizard; this guide teaches the everyday
 * TokenBird workflow after a user can actually interact with the workspace.
 */
export function GettingStartedGuide({ open, onComplete }: GettingStartedGuideProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onComplete() }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <div className="relative overflow-hidden px-5 pb-5 pt-7 sm:px-8 sm:pb-7 sm:pt-8">
          <div className="pointer-events-none absolute -right-24 -top-24 size-64 rounded-full bg-accent/10 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-28 -left-20 size-56 rounded-full bg-foreground/[0.04] blur-3xl" />

          <DialogHeader className="relative pr-7 text-left">
            <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/45">
              <Sparkles className="size-3.5 text-accent" />
              {t('gettingStarted.eyebrow')}
            </div>
            <DialogTitle className="max-w-2xl text-2xl leading-tight sm:text-[28px]">
              {t('gettingStarted.title')}
            </DialogTitle>
            <DialogDescription className="max-w-2xl text-sm leading-relaxed text-foreground/60">
              {t('gettingStarted.description')}
            </DialogDescription>
          </DialogHeader>

          <div className="relative mt-6 grid gap-3 sm:grid-cols-2">
            <GuideCard
              icon={MessageSquare}
              title={t('gettingStarted.create.title')}
              description={t('gettingStarted.create.description')}
              className="sm:col-span-2"
            >
              <div className="mt-3 rounded-lg border border-foreground/[0.08] bg-foreground/[0.035] px-3 py-2.5 text-xs italic leading-relaxed text-foreground/70">
                “{t('gettingStarted.create.example')}”
              </div>
            </GuideCard>

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
          </div>

          <div className="relative mt-3 rounded-xl border border-accent/20 bg-accent/[0.07] p-4 sm:flex sm:items-start sm:gap-4">
            <div className="mb-3 flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 sm:mb-0">
              <Sparkles className="size-[18px] text-accent" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">{t('gettingStarted.loop.title')}</h3>
              <p className="mt-1 text-xs leading-relaxed text-foreground/65">{t('gettingStarted.loop.description')}</p>
              <p className="mt-2 text-[11px] leading-relaxed text-foreground/45">{t('gettingStarted.loop.safety')}</p>
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-foreground/10 bg-background/80 px-5 py-4 sm:px-8">
          <Button onClick={onComplete} className="w-full sm:w-auto">
            {t('gettingStarted.start')}
            <ArrowRight className="size-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

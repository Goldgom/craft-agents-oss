import { useTranslation } from 'react-i18next'
import { useEffect, useState } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, Check, KeyRound, LoaderCircle, RefreshCw, Settings2, Sparkles } from 'lucide-react'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import tokenNestIcon from '@/assets/provider-icons/tokennest.png'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { StudioConnectionPicker } from './useStudioConnections'
import { isImageConnection } from './image-connections'
import type { StudioConnectionIssue } from './studio-connection-error'

type Props = {
  open: boolean
  issue: StudioConnectionIssue | null
  onClose: () => void
  onFinish: () => void
  onReauthorized: () => void
  onOpenAiSettings: () => void
  connections: LlmConnectionWithStatus[]
  connection?: LlmConnectionWithStatus
  connectionSlug: string
  setConnectionSlug: (slug: string) => void
  model: string
  setModel: (model: string) => void
  channelGroup: string
  setChannelGroup: (group: string) => void
  imageReady: boolean
  imageGroupCount: number
  loginTokenNest: () => Promise<void>
  refresh: () => Promise<void>
}

export function StudioImageConnectionDialog(props: Props) {
  const { t } = useTranslation()
  const [page, setPage] = useState<'tokennest' | 'other'>('tokennest')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const tokenNest = props.connections.find(item => item.oauthProvider === 'tokennest')
  const tokenNestSelected = props.connection?.oauthProvider === 'tokennest'
  const tokenNestReady = tokenNestSelected && props.imageReady && props.issue !== 'reauth'
  const otherConnections = props.connections.filter(item => isImageConnection(item) && item.oauthProvider !== 'tokennest')

  useEffect(() => { if (props.issue) { setPage('tokennest'); setError('') } }, [props.issue])

  async function run(action: () => Promise<void>) {
    setPending(true)
    setError('')
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }

  function selectTokenNest() {
    if (tokenNest) props.setConnectionSlug(tokenNest.slug)
  }

  async function login() {
    await props.loginTokenNest()
    props.onReauthorized()
  }

  const fieldClass = 'flex w-full items-center gap-3 rounded-xl border border-border/70 bg-background/70 p-4 text-left shadow-minimal transition-colors hover:border-primary/40 hover:bg-accent/40'
  const primaryClass = 'inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'

  return <Dialog open={props.open} onOpenChange={open => { if (!open) props.onClose() }}>
    <DialogContent className="max-h-[min(85vh,720px)] max-w-xl overflow-y-auto">
      <DialogHeader>
        <div className="mb-1 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary"><Sparkles className="size-6" /></div>
        <DialogTitle>{props.issue === 'reauth' ? t('studio.reauthTokenNest') : props.issue === 'channel' ? t('studio.checkImageConnection') : page === 'tokennest' ? t('studio.connectDrawing') : t('studio.configureOtherDrawing')}</DialogTitle>
        <DialogDescription>{page === 'tokennest' ? t('studio.tokenNestDrawingIntro') : t('studio.reuseCredentials')}</DialogDescription>
      </DialogHeader>

      {page === 'tokennest' ? <div className="space-y-4">
        {props.issue && <div role="alert" className="flex gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5"><AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" /><div><strong className="text-foreground">{props.issue === 'reauth' ? t('studio.authorizationNeeded') : t('studio.groupModelUnavailable')}</strong><p className="mt-1 text-muted-foreground">{props.issue === 'reauth' ? t('studio.authorizationHint') : t('studio.groupUnavailableHint')}</p></div></div>}
        <div className="rounded-xl border border-primary/25 bg-primary/[0.04] p-4 shadow-minimal">
          <div className="flex items-start gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-background"><img src={tokenNestIcon} alt="" className="size-8 object-contain" /></div>
            <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><strong className="text-sm">TokenNest</strong><span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">{t('studio.recommended')}</span></div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('studio.oauthDrawingHint')}</p></div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button className={primaryClass} disabled={pending} onClick={() => void run(login)}>{pending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}{tokenNest?.isAuthenticated ? t('studio.reauthTokenNest') : t('studio.signInWithTokenNest')}</button>
            {tokenNest?.isAuthenticated && !tokenNestSelected && <button className="h-10 rounded-lg border border-border px-3 text-xs hover:bg-accent" onClick={selectTokenNest}>{t('studio.useSignedInAccount')}</button>}
          </div>
        </div>

        {tokenNestSelected && tokenNest?.isAuthenticated && <div className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-4">
          <div className="flex items-center gap-2 text-xs font-medium">{props.issue === 'reauth' ? <AlertCircle className="size-4 text-amber-600" /> : <Check className="size-4 text-emerald-500" />}{props.issue === 'reauth' ? t('studio.currentAuthorizationNeeded') : t('studio.tokenNestConnected')}</div>
          {props.imageGroupCount > 0 ? <><p className="text-xs text-muted-foreground">{t('studio.drawingSettings')}</p><StudioConnectionPicker image connections={props.connections} connectionSlug={props.connectionSlug} setConnectionSlug={props.setConnectionSlug} model={props.model} setModel={props.setModel} channelGroup={props.channelGroup} setChannelGroup={props.setChannelGroup} /></>
            : <div className="space-y-2 text-xs leading-5 text-muted-foreground"><p>{t('studio.noImageGroupHint')}</p>
              <button className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-50" disabled={pending} onClick={() => void run(props.refresh)}><RefreshCw className={`size-3.5 ${pending ? 'animate-spin' : ''}`} />{t('studio.refreshGroups')}</button></div>}
        </div>}
        {tokenNestSelected && !tokenNest?.isAuthenticated && <p className="text-xs text-muted-foreground">{t('studio.signInExpired')}</p>}
        <button className={fieldClass} onClick={() => { setError(''); setPage('other') }}><span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted"><KeyRound className="size-5 text-muted-foreground" /></span><span className="min-w-0 flex-1"><strong className="text-sm">{t('studio.otherConnections')}</strong><span className="mt-0.5 block text-xs text-muted-foreground">{t('studio.otherConnectionHint')}</span></span><ArrowRight className="size-4 text-muted-foreground" /></button>
        {tokenNestReady && <button className={`${primaryClass} w-full`} onClick={props.onFinish}>{t('studio.startDrawing')}</button>}
      </div> : <div className="space-y-4">
        <button className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => { setError(''); setPage('tokennest') }}><ArrowLeft className="size-3.5" />{t('studio.backToTokenNest')}</button>
        <div className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-4">
          <div><strong className="text-sm">{t('studio.chooseConfiguredConnection')}</strong><p className="mt-1 text-xs text-muted-foreground">{t('studio.imageModelHint')}</p></div>
          {otherConnections.length > 0 ? <StudioConnectionPicker image connections={otherConnections} connectionSlug={tokenNestSelected ? '' : props.connectionSlug} setConnectionSlug={props.setConnectionSlug} model={tokenNestSelected ? '' : props.model} setModel={props.setModel} channelGroup={props.channelGroup} setChannelGroup={props.setChannelGroup} />
            : <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{t('studio.noDrawingConnections')}</p>}
          {props.connection && !tokenNestSelected && !props.connection.isAuthenticated && <p className="text-xs text-destructive">{t('studio.missingKeyHint')}</p>}
          {props.connection && !tokenNestSelected && props.connection.isAuthenticated && !props.model.trim() && <p className="text-xs text-muted-foreground">{t('studio.imageModelRequired')}</p>}
        </div>
        <div className="rounded-xl border border-border/70 p-4"><strong className="text-sm">{t('studio.manageConnections')}</strong><p className="mt-1 text-xs leading-5 text-muted-foreground">{t('studio.addConnectionHint')}</p>
          <button className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs font-medium hover:bg-accent" onClick={props.onOpenAiSettings}><Settings2 className="size-4" />{t('studio.openAiSettings')}<ArrowRight className="size-3.5" /></button>
        </div>
        {props.imageReady && !tokenNestSelected && <button className={`${primaryClass} w-full`} onClick={props.onFinish}>{t('studio.startDrawing')}</button>}
      </div>}
      {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      <DialogFooter><button className="w-full rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground" onClick={props.onClose}>{t('studio.setupLater')}</button></DialogFooter>
    </DialogContent>
  </Dialog>
}

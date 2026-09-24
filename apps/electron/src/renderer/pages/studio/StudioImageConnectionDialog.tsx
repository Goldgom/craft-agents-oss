import { useEffect, useState } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, Check, KeyRound, LoaderCircle, RefreshCw, Settings2, Sparkles } from 'lucide-react'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import tokenNestIcon from '@/assets/provider-icons/tokennest.png'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
        <DialogTitle>{props.issue === 'reauth' ? '重新登录 TokenNest' : props.issue === 'channel' ? '检查图片连接' : page === 'tokennest' ? '连接 AI 绘画服务' : '配置其他绘画连接'}</DialogTitle>
        <DialogDescription>{page === 'tokennest' ? '使用 TokenNest 账户登录，选择图片生成分组和模型后即可开始创作。' : '复用 Agent 的官方或自定义 API Key；凭据统一保存在 AI 设置中。'}</DialogDescription>
      </DialogHeader>

      {page === 'tokennest' ? <div className="space-y-4">
        {props.issue && <div role="alert" className="flex gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5"><AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" /><div><strong className="text-foreground">{props.issue === 'reauth' ? '授权需要更新' : '当前分组无法生成所选模型'}</strong><p className="mt-1 text-muted-foreground">{props.issue === 'reauth' ? '当前登录已失效，或旧版授权缺少读取图片分组所需权限。请重新登录后再试。' : '请切换有可用渠道的图片分组或模型。若使用较早的 OAuth 授权，也可以重新登录以更新分组权限。'}</p></div></div>}
        <div className="rounded-xl border border-primary/25 bg-primary/[0.04] p-4 shadow-minimal">
          <div className="flex items-start gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-background"><img src={tokenNestIcon} alt="" className="size-8 object-contain" /></div>
            <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><strong className="text-sm">TokenNest</strong><span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">推荐</span></div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">通过浏览器完成 OAuth2 授权，画布使用账户可访问的图片生成分组。</p></div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button className={primaryClass} disabled={pending} onClick={() => void run(login)}>{pending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}{tokenNest?.isAuthenticated ? '重新登录 TokenNest' : '使用 TokenNest 登录'}</button>
            {tokenNest?.isAuthenticated && !tokenNestSelected && <button className="h-10 rounded-lg border border-border px-3 text-xs hover:bg-accent" onClick={selectTokenNest}>使用已登录账户</button>}
          </div>
        </div>

        {tokenNestSelected && tokenNest?.isAuthenticated && <div className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-4">
          <div className="flex items-center gap-2 text-xs font-medium">{props.issue === 'reauth' ? <AlertCircle className="size-4 text-amber-600" /> : <Check className="size-4 text-emerald-500" />}{props.issue === 'reauth' ? '当前授权需要更新' : 'TokenNest 已连接'}</div>
          {props.imageGroupCount > 0 ? <><p className="text-xs text-muted-foreground">绘画设置</p><StudioConnectionPicker image connections={props.connections} connectionSlug={props.connectionSlug} setConnectionSlug={props.setConnectionSlug} model={props.model} setModel={props.setModel} channelGroup={props.channelGroup} setChannelGroup={props.setChannelGroup} /></>
            : <div className="space-y-2 text-xs leading-5 text-muted-foreground"><p>当前账户尚无可用的图片生成分组。请在 TokenNest 检查图片生成权限，配置后刷新；如果使用图片渠道 API Key，可在“其他连接”中添加。</p>
              <button className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-50" disabled={pending} onClick={() => void run(props.refresh)}><RefreshCw className={`size-3.5 ${pending ? 'animate-spin' : ''}`} />刷新分组</button></div>}
        </div>}
        {tokenNestSelected && !tokenNest?.isAuthenticated && <p className="text-xs text-muted-foreground">登录已失效，请重新授权。</p>}
        <button className={fieldClass} onClick={() => { setError(''); setPage('other') }}><span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted"><KeyRound className="size-5 text-muted-foreground" /></span><span className="min-w-0 flex-1"><strong className="text-sm">其他连接</strong><span className="mt-0.5 block text-xs text-muted-foreground">OpenAI 官方 Key、TokenNest 图片渠道 Key 或自定义兼容接口</span></span><ArrowRight className="size-4 text-muted-foreground" /></button>
        {tokenNestReady && <button className={`${primaryClass} w-full`} onClick={props.onFinish}>开始绘画</button>}
      </div> : <div className="space-y-4">
        <button className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => { setError(''); setPage('tokennest') }}><ArrowLeft className="size-3.5" />返回 TokenNest 登录</button>
        <div className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-4">
          <div><strong className="text-sm">选择已配置的连接</strong><p className="mt-1 text-xs text-muted-foreground">选择图片生成模型；首次进入默认使用该连接的第一个可用模型。</p></div>
          {otherConnections.length > 0 ? <StudioConnectionPicker image connections={otherConnections} connectionSlug={tokenNestSelected ? '' : props.connectionSlug} setConnectionSlug={props.setConnectionSlug} model={tokenNestSelected ? '' : props.model} setModel={props.setModel} channelGroup={props.channelGroup} setChannelGroup={props.setChannelGroup} />
            : <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">还没有可用的绘画连接</p>}
          {props.connection && !tokenNestSelected && !props.connection.isAuthenticated && <p className="text-xs text-destructive">此连接尚未配置密钥。请在 AI 设置中完成配置。</p>}
          {props.connection && !tokenNestSelected && props.connection.isAuthenticated && !props.model.trim() && <p className="text-xs text-muted-foreground">请先为此连接配置或填写图像模型。</p>}
        </div>
        <div className="rounded-xl border border-border/70 p-4"><strong className="text-sm">添加或管理连接</strong><p className="mt-1 text-xs leading-5 text-muted-foreground">在 AI 设置中添加 OpenAI 官方 API Key，或添加 OpenAI 兼容接口并填写地址与密钥。TokenNest 图片渠道 Key 的接口地址为 https://openai.goldgom.top/v1。</p>
          <button className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs font-medium hover:bg-accent" onClick={props.onOpenAiSettings}><Settings2 className="size-4" />打开 AI 设置<ArrowRight className="size-3.5" /></button>
        </div>
        {props.imageReady && !tokenNestSelected && <button className={`${primaryClass} w-full`} onClick={props.onFinish}>开始绘画</button>}
      </div>}
      {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      <button className="w-full rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground" onClick={props.onClose}>稍后设置，返回画布</button>
    </DialogContent>
  </Dialog>
}

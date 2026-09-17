import { useEffect, useState } from 'react'
import { ChevronLeft, RefreshCw, SlidersHorizontal, Sparkles, Wifi } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { navigate, routes } from '@/lib/navigate'

type AndroidBridge = {
  configureServer?: () => void
  reload?: () => void
}

function androidBridge(): AndroidBridge | undefined {
  return (window as Window & { CraftAgentAndroid?: AndroidBridge }).CraftAgentAndroid
}

/**
 * Settings surface for the Android WebView.
 *
 * Desktop settings assume a three-column Electron layout. Android keeps a
 * single content panel and therefore gets this deliberately small, touch
 * friendly page instead of relying on the desktop settings navigator.
 */
export default function AndroidSettingsPage() {
  const [serverConfig, setServerConfig] = useState<string>('本地服务器')
  const [thinkingLevel, setThinkingLevel] = useState<string>('加载中…')

  useEffect(() => {
    const loadServerConfig = async () => {
      try {
        const response = await fetch('/api/mobile-config', { cache: 'no-store' })
        if (response.ok) {
          const config = await response.json() as { mode?: string; wsUrl?: string }
          setServerConfig(config.mode === 'local' ? '本地模式 · 仅此设备' : config.wsUrl ?? '服务器模式')
          return
        }
      } catch {
        // Fall through to the shared server API for browser/dev previews.
      }
      try {
        const config: any = await window.electronAPI.getServerConfig?.()
        const url = typeof config?.url === 'string' ? config.url : config?.serverUrl
        if (url) setServerConfig(url)
      } catch {
        // Keep the friendly default label when the connection is unavailable.
      }
    }
    void loadServerConfig()
    window.electronAPI.getDefaultThinkingLevel?.()
      .then((level: any) => setThinkingLevel(String(level)))
      .catch(() => setThinkingLevel('默认'))
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex min-h-[60px] items-center gap-2 border-b border-border/50 bg-background/90 px-3 backdrop-blur-xl">
        <Button
          variant="ghost"
          size="icon"
          className="size-10 rounded-full"
          aria-label="返回"
          onClick={() => navigate(routes.view.allSessions(), { skipAutoSelect: true })}
        >
          <ChevronLeft className="size-5" />
        </Button>
        <div>
          <h1 className="text-lg font-semibold leading-tight">设置</h1>
          <p className="text-[11px] text-muted-foreground">移动端控制中心</p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-gradient-to-b from-primary/[0.04] to-transparent px-4 py-5 pb-24">
        <div className="mb-6 overflow-hidden rounded-2xl border border-primary/15 bg-primary/[0.06] p-4">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground shadow-minimal">
              <Sparkles className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold">词元鸟</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">连接、模型与应用维护都集中在这里</p>
            </div>
          </div>
        </div>

        <section className="mb-5">
          <h2 className="mb-2 px-1 text-xs font-medium tracking-wide text-muted-foreground">连接</h2>
          <div className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-xs">
            <button
              type="button"
              className="flex min-h-[76px] w-full items-center gap-3 px-4 text-left transition-colors active:bg-foreground/5"
              onClick={() => androidBridge()?.configureServer?.()}
            >
              <span className="grid size-10 place-items-center rounded-xl bg-sky-500/10 text-sky-500"><Wifi className="size-5" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium">连接方式</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{serverConfig}</span>
              </span>
              <span className="text-muted-foreground">›</span>
            </button>
          </div>
        </section>

        <section className="mb-5">
          <h2 className="mb-2 px-1 text-xs font-medium tracking-wide text-muted-foreground">AI 与模型</h2>
          <div className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-xs">
            <button
              type="button"
              className="flex min-h-[76px] w-full items-center gap-3 px-4 text-left transition-colors active:bg-foreground/5"
              onClick={() => navigate(routes.view.settings('ai'))}
            >
              <span className="grid size-10 place-items-center rounded-xl bg-violet-500/10 text-violet-500"><SlidersHorizontal className="size-5" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium">模型与连接</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">管理 Anthropic、Pi 和兼容 API</span>
              </span>
              <span className="text-muted-foreground">›</span>
            </button>
            <div className="mx-4 border-t border-border/50" />
            <div className="flex min-h-[56px] items-center gap-3 px-4">
              <span className="min-w-0 flex-1 text-[15px]">默认思考级别</span>
              <span className="text-sm text-muted-foreground">{thinkingLevel}</span>
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-2 px-1 text-xs font-medium tracking-wide text-muted-foreground">应用维护</h2>
          <div className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-xs">
            <button
              type="button"
              className="flex min-h-[72px] w-full items-center gap-3 px-4 text-left transition-colors active:bg-foreground/5"
              onClick={() => androidBridge()?.reload?.()}
            >
              <span className="grid size-10 place-items-center rounded-xl bg-emerald-500/10 text-emerald-500"><RefreshCw className="size-5" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium">刷新应用</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">重新加载界面并恢复连接</span>
              </span>
              <span className="text-muted-foreground">›</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

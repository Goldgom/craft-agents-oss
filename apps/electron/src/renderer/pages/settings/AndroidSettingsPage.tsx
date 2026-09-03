import { useEffect, useState } from 'react'
import { ChevronLeft, RefreshCw, Server, SlidersHorizontal } from 'lucide-react'
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
    window.electronAPI.getServerConfig?.()
      .then((config: any) => {
        const url = typeof config?.url === 'string' ? config.url : config?.serverUrl
        if (url) setServerConfig(url)
      })
      .catch(() => {})
    window.electronAPI.getDefaultThinkingLevel?.()
      .then((level: any) => setThinkingLevel(String(level)))
      .catch(() => setThinkingLevel('默认'))
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex min-h-[56px] items-center gap-2 border-b border-border/60 px-3">
        <Button
          variant="ghost"
          size="icon"
          className="size-10 rounded-full"
          aria-label="返回"
          onClick={() => navigate(routes.view.allSessions(), { skipAutoSelect: true })}
        >
          <ChevronLeft className="size-5" />
        </Button>
        <h1 className="text-lg font-semibold">设置</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 pb-24">
        <section className="mb-5">
          <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">连接</h2>
          <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
            <button
              type="button"
              className="flex min-h-[68px] w-full items-center gap-3 px-4 text-left active:bg-foreground/5"
              onClick={() => androidBridge()?.configureServer?.()}
            >
              <Server className="size-5 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium">服务器配置</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{serverConfig}</span>
              </span>
              <span className="text-muted-foreground">›</span>
            </button>
          </div>
        </section>

        <section className="mb-5">
          <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">AI</h2>
          <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
            <button
              type="button"
              className="flex min-h-[68px] w-full items-center gap-3 px-4 text-left active:bg-foreground/5"
              onClick={() => navigate(routes.view.settings('ai'))}
            >
              <SlidersHorizontal className="size-5 text-muted-foreground" />
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
          <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">应用</h2>
          <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
            <button
              type="button"
              className="flex min-h-[68px] w-full items-center gap-3 px-4 text-left active:bg-foreground/5"
              onClick={() => androidBridge()?.reload?.()}
            >
              <RefreshCw className="size-5 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium">刷新应用</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">重新连接本地服务</span>
              </span>
              <span className="text-muted-foreground">›</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import {
  Bell,
  CalendarDays,
  Camera,
  ChevronLeft,
  Contact,
  ExternalLink,
  Film,
  Images,
  MapPin,
  Mic,
  Music,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
  Wifi,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { navigate, routes } from '@/lib/navigate'
import {
  invokeAndroidNative,
  parseAndroidJson,
  type AndroidBridge,
  type AndroidPermissionKey,
  type AndroidPermissionSnapshot,
  type NetworkAdbConfig,
} from '../../../shared/android-native'

function androidBridge(): AndroidBridge | undefined {
  return (window as Window & { CraftAgentAndroid?: AndroidBridge }).CraftAgentAndroid
}

const DEFAULT_ADB_CONFIG: NetworkAdbConfig = {
  enabled: false,
  host: '127.0.0.1',
  port: 5555,
  requiresSystemPairing: true,
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
  const [permissionSnapshot, setPermissionSnapshot] = useState<AndroidPermissionSnapshot>({ permissions: [] })
  const [requestingPermission, setRequestingPermission] = useState<AndroidPermissionKey | null>(null)
  const [adbConfig, setAdbConfig] = useState<NetworkAdbConfig>(DEFAULT_ADB_CONFIG)
  const [adbMessage, setAdbMessage] = useState('')

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

    const bridge = androidBridge()
    if (bridge) {
      setPermissionSnapshot(parseAndroidJson(bridge.getPermissionSnapshot(), { permissions: [] }))
      setAdbConfig(parseAndroidJson(bridge.getNetworkAdbConfig(), DEFAULT_ADB_CONFIG))
    }
  }, [])

  const permissionItems: Array<{
    key: AndroidPermissionKey
    label: string
    description: string
    icon: typeof Camera
  }> = [
    { key: 'camera', label: '相机', description: '拍摄照片、扫描资料', icon: Camera },
    { key: 'microphone', label: '麦克风', description: '语音输入与录音任务', icon: Mic },
    { key: 'notifications', label: '通知', description: '任务完成与后台提醒', icon: Bell },
    { key: 'photos', label: '照片', description: '读取用户允许的图片', icon: Images },
    { key: 'videos', label: '视频', description: '读取用户允许的视频', icon: Film },
    { key: 'audio', label: '音频', description: '读取设备上的音频媒体', icon: Music },
    { key: 'location', label: '位置', description: '需要地点上下文的任务', icon: MapPin },
    { key: 'contacts', label: '联系人', description: '读取通讯录前仍需明确用途', icon: Contact },
    { key: 'calendar', label: '日历', description: '读取或写入日程', icon: CalendarDays },
  ]

  const refreshPermissions = () => {
    const bridge = androidBridge()
    if (!bridge) return
    setPermissionSnapshot(parseAndroidJson(bridge.getPermissionSnapshot(), { permissions: [] }))
  }

  const requestPermission = async (key: AndroidPermissionKey, label: string) => {
    const bridge = androidBridge()
    if (!bridge || requestingPermission) return
    setRequestingPermission(key)
    try {
      await invokeAndroidNative<AndroidPermissionSnapshot>(
        'craft-agent:android-permission-result',
        requestId => bridge.requestPermission(requestId, key, `你正在权限管理中启用“${label}”权限。`),
      )
    } catch {
      // Native Android already showed the authoritative result to the user.
    } finally {
      refreshPermissions()
      setRequestingPermission(null)
    }
  }

  const saveAdb = () => {
    const bridge = androidBridge()
    if (!bridge) return
    const result = parseAndroidJson<{ success: boolean; error?: string; config?: NetworkAdbConfig }>(
      bridge.setNetworkAdbConfig(adbConfig.host, adbConfig.port, adbConfig.enabled),
      { success: false, error: '保存失败' },
    )
    if (result.success && result.config) {
      setAdbConfig(result.config)
      setAdbMessage('网络 ADB 配置已保存')
    } else {
      setAdbMessage(result.error ?? '网络 ADB 配置无效')
    }
  }

  const testAdb = async () => {
    const bridge = androidBridge()
    if (!bridge) return
    setAdbMessage('正在连接…')
    try {
      const result = await invokeAndroidNative<{ stdout?: string }>(
        'craft-agent:android-adb-result',
        requestId => bridge.testNetworkAdb(requestId),
        40_000,
      )
      setAdbMessage(result.stdout?.includes('tokenbird-adb-ready') ? '连接成功' : '已连接，但返回内容异常')
    } catch (error) {
      setAdbMessage(error instanceof Error ? error.message : '连接失败')
    }
  }

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

        <section className="mb-5">
          <h2 className="mb-2 px-1 text-xs font-medium tracking-wide text-muted-foreground">权限管理</h2>
          <div className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-xs">
            <div className="flex items-start gap-3 border-b border-border/50 px-4 py-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-500"><ShieldCheck className="size-5" /></span>
              <div>
                <p className="text-[15px] font-medium">按需授权</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">AI 只能申请下列白名单权限；Android 会显示系统确认框，拒绝后任务不会绕过授权。</p>
              </div>
            </div>
            {permissionItems.map(({ key, label, description, icon: Icon }, index) => {
              const granted = permissionSnapshot.permissions.find(item => item.key === key)?.status === 'granted'
              return (
                <button
                  key={key}
                  type="button"
                  className={`flex min-h-[68px] w-full items-center gap-3 px-4 text-left active:bg-foreground/5 ${index > 0 ? 'border-t border-border/50' : ''}`}
                  disabled={granted || requestingPermission !== null}
                  onClick={() => void requestPermission(key, label)}
                >
                  <Icon className="size-5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px]">{label}</span>
                    <span className="block text-xs text-muted-foreground">{description}</span>
                  </span>
                  <span className={granted ? 'text-xs text-emerald-500' : 'text-xs text-muted-foreground'}>
                    {granted ? '已允许' : requestingPermission === key ? '等待确认…' : '申请'}
                  </span>
                </button>
              )
            })}
            <button
              type="button"
              className="flex min-h-[58px] w-full items-center gap-3 border-t border-border/50 px-4 text-left active:bg-foreground/5"
              onClick={() => androidBridge()?.openApplicationSettings()}
            >
              <ExternalLink className="size-5 text-muted-foreground" />
              <span className="flex-1 text-[15px]">打开 Android 应用权限设置</span>
              <span className="text-muted-foreground">›</span>
            </button>
          </div>
        </section>

        <section className="mb-5">
          <h2 className="mb-2 px-1 text-xs font-medium tracking-wide text-muted-foreground">高级功能</h2>
          <div className="overflow-hidden rounded-2xl border border-amber-500/25 bg-card shadow-xs">
            <div className="flex items-start gap-3 border-b border-border/50 px-4 py-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-500"><TerminalSquare className="size-5" /></span>
              <div>
                <p className="text-[15px] font-medium">网络 ADB</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">仅供高级用户。请先在系统中完成无线调试或 TCP ADB 授权；AI 每次执行命令仍需你单独确认。</p>
              </div>
            </div>
            <label className="flex min-h-[58px] items-center gap-3 px-4">
              <span className="flex-1 text-[15px]">允许 TokenBird 使用网络 ADB</span>
              <input
                type="checkbox"
                checked={adbConfig.enabled}
                onChange={event => setAdbConfig(config => ({ ...config, enabled: event.target.checked }))}
                className="size-5 accent-primary"
              />
            </label>
            <div className="grid grid-cols-[1fr_96px] gap-2 border-t border-border/50 px-4 py-3">
              <input
                value={adbConfig.host}
                onChange={event => setAdbConfig(config => ({ ...config, host: event.target.value }))}
                placeholder="127.0.0.1"
                className="h-11 min-w-0 rounded-xl border border-border bg-transparent px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
              <input
                value={adbConfig.port}
                type="number"
                min={1}
                max={65535}
                onChange={event => setAdbConfig(config => ({ ...config, port: Number(event.target.value) }))}
                className="h-11 rounded-xl border border-border bg-transparent px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="grid grid-cols-2 gap-2 border-t border-border/50 px-4 py-3">
              <Button variant="outline" onClick={saveAdb}>保存配置</Button>
              <Button variant="outline" disabled={!adbConfig.enabled} onClick={() => void testAdb()}>测试连接</Button>
            </div>
            {adbMessage && <p className="px-4 pb-3 text-xs text-muted-foreground">{adbMessage}</p>}
            <button
              type="button"
              className="flex min-h-[58px] w-full items-center gap-3 border-t border-border/50 px-4 text-left active:bg-foreground/5"
              onClick={() => androidBridge()?.openWirelessDebuggingSettings()}
            >
              <Wifi className="size-5 text-muted-foreground" />
              <span className="flex-1 text-[15px]">打开系统无线调试设置</span>
              <ExternalLink className="size-4 text-muted-foreground" />
            </button>
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

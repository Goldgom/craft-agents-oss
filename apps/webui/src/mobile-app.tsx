import { useEffect, useState } from 'react'
import {
  Archive,
  Bot,
  Database,
  FileCode,
  Flag,
  FolderKanban,
  FolderOpen,
  History,
  Menu,
  MousePointerClick,
  PlugZap,
  RefreshCw,
  Server,
  Settings,
  Sparkles,
  Tag,
  Wrench,
  Clock,
  MonitorCog,
  X,
  Zap,
} from 'lucide-react'
import { navigate, routes } from '../../electron/src/renderer/lib/navigate'
import type { Workspace } from '../../electron/src/shared/types'

type AndroidBridge = {
  reload: () => void
  configureServer: () => void
}

declare global {
  interface Window {
    CraftAgentAndroid?: AndroidBridge
  }
}

function isAndroidApp() {
  return new URLSearchParams(window.location.search).get('embedded') === 'android'
    && Boolean(window.CraftAgentAndroid)
}

/** Keep the shared renderer sized to the usable Android WebView viewport. */
export function useMobileAppViewport() {
  useEffect(() => {
    if (!isAndroidApp()) return

    const root = document.documentElement
    const body = document.body
    root.dataset.mobileApp = 'android'
    body.dataset.mobileApp = 'android'

    const updateViewport = () => {
      const viewport = window.visualViewport
      const height = Math.round(viewport?.height ?? window.innerHeight)
      root.style.setProperty('--app-viewport-height', `${height}px`)
      root.classList.toggle('keyboard-open', height < window.innerHeight - 120)
    }

    updateViewport()
    window.addEventListener('resize', updateViewport)
    window.visualViewport?.addEventListener('resize', updateViewport)
    window.visualViewport?.addEventListener('scroll', updateViewport)

    return () => {
      window.removeEventListener('resize', updateViewport)
      window.visualViewport?.removeEventListener('resize', updateViewport)
      window.visualViewport?.removeEventListener('scroll', updateViewport)
      root.style.removeProperty('--app-viewport-height')
      root.classList.remove('keyboard-open')
      delete root.dataset.mobileApp
      delete body.dataset.mobileApp
    }
  }, [])
}

type MobileNavigationItem = {
  label: string
  route: Parameters<typeof navigate>[0]
  icon: typeof History
  subitem?: boolean
}

const MOBILE_NAVIGATION_ITEMS: MobileNavigationItem[] = [
  { label: '历史会话', route: routes.view.allSessions(), icon: History },
  { label: '已标记', route: routes.view.flagged(), icon: Flag },
  { label: '已归档', route: routes.view.archived(), icon: Archive },
  { label: '标签', route: routes.view.label('__all__'), icon: Tag },
  { label: '自动化', route: routes.view.automations(), icon: Zap },
  { label: '定时自动化', route: routes.view.automationsScheduled(), icon: Clock, subitem: true },
  { label: '事件自动化', route: routes.view.automationsEvent(), icon: MousePointerClick, subitem: true },
  { label: '脚本监控', route: routes.view.automationsScriptMonitor(), icon: MonitorCog, subitem: true },
  { label: '智能体', route: routes.view.automationsAgents(), icon: Bot, subitem: true },
  { label: '数据源', route: routes.view.sources(), icon: Database },
  { label: 'API', route: routes.view.sourcesApi(), icon: PlugZap, subitem: true },
  { label: 'MCP', route: routes.view.sourcesMcp(), icon: PlugZap, subitem: true },
  { label: '本地文件夹', route: routes.view.sourcesLocal(), icon: FolderOpen, subitem: true },
  { label: '工具', route: routes.view.tools(), icon: Wrench },
  { label: '内置 CLI', route: routes.view.tools('builtin'), icon: FileCode, subitem: true },
  { label: '自定义 CLI', route: routes.view.tools('custom'), icon: FileCode, subitem: true },
  { label: 'Skill', route: routes.view.skills(), icon: Sparkles },
  { label: '项目', route: routes.view.projects(), icon: FolderKanban },
  { label: '设置', route: routes.view.settings('app'), icon: Settings },
]

/**
 * Android compact controls. These are intentionally separate buttons in one
 * fixed row: frequent destinations are one tap away, while the menu button
 * opens the complete navigation drawer.
 */
export function MobileControls() {
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [switchingWorkspaceId, setSwitchingWorkspaceId] = useState<string | null>(null)
  const android = isAndroidApp()

  useEffect(() => {
    if (!navigationOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavigationOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigationOpen])

  useEffect(() => {
    if (!android) return

    let cancelled = false
    const loadWorkspaces = async () => {
      try {
        const [availableWorkspaces, activeId] = await Promise.all([
          window.electronAPI.getWorkspaces(),
          window.electronAPI.getWindowWorkspace(),
        ])
        if (cancelled) return
        setWorkspaces(availableWorkspaces)
        setActiveWorkspaceId(activeId)
      } catch (error) {
        // The main app has its own loading/error handling. Do not make a
        // secondary floating control prevent it from rendering.
        console.error('[MobileControls] Failed to load workspaces:', error)
      }
    }

    void loadWorkspaces()
    return () => { cancelled = true }
  }, [android])

  if (!android) return null

  const closeNavigation = () => setNavigationOpen(false)
  const closeOverlays = () => {
    setNavigationOpen(false)
    setWorkspaceOpen(false)
  }
  const navigateTo = (route: Parameters<typeof navigate>[0]) => {
    closeNavigation()
    // List navigators must open on their list in compact mode. In particular,
    // Android's automation entry should not immediately drill into the first
    // automation while the user is trying to browse the available entries.
    const skipAutoSelect = route === routes.view.allSessions() || route.startsWith('automations')
    navigate(route, skipAutoSelect ? { skipAutoSelect: true } : undefined)
  }
  const switchWorkspace = async (workspaceId: string) => {
    if (workspaceId === activeWorkspaceId || switchingWorkspaceId) {
      setWorkspaceOpen(false)
      return
    }

    setSwitchingWorkspaceId(workspaceId)
    try {
      await window.electronAPI.switchWorkspace(workspaceId)

      // The shared Electron App owns several workspace-scoped stores. Reload
      // with the selected ID so it starts with a clean, correctly scoped state.
      const url = new URL(window.location.href)
      url.searchParams.set('workspace', workspaceId)
      url.searchParams.delete('session')
      window.location.assign(url.toString())
    } catch (error) {
      console.error('[MobileControls] Failed to switch workspace:', error)
      setSwitchingWorkspaceId(null)
    }
  }

  const activeWorkspace = workspaces.find(workspace => workspace.id === activeWorkspaceId)

  return (
    <>
      <div className="mobile-workspace-controls" data-open={workspaceOpen || undefined}>
        {workspaceOpen && (
          <button
            type="button"
            className="mobile-workspace-controls__backdrop"
            aria-label="关闭工作区列表"
            onClick={closeOverlays}
          />
        )}

        <button
          type="button"
          className="mobile-workspace-controls__trigger"
          aria-label={`切换工作区${activeWorkspace ? `，当前：${activeWorkspace.name}` : ''}`}
          title={activeWorkspace?.name ?? '切换工作区'}
          aria-expanded={workspaceOpen}
          aria-controls="mobile-workspace-controls-panel"
          onClick={() => {
            setNavigationOpen(false)
            setWorkspaceOpen(value => !value)
          }}
        >
          <FolderKanban aria-hidden="true" />
        </button>

        {workspaceOpen && (
          <section
            id="mobile-workspace-controls-panel"
            className="mobile-workspace-controls__panel"
            aria-label="切换工作区"
          >
            <div className="mobile-workspace-controls__header">切换工作区</div>
            {workspaces.map(workspace => {
              const selected = workspace.id === activeWorkspaceId
              const switching = workspace.id === switchingWorkspaceId
              return (
                <button
                  key={workspace.id}
                  type="button"
                  className={selected ? 'mobile-workspace-controls__item is-active' : 'mobile-workspace-controls__item'}
                  disabled={selected || Boolean(switchingWorkspaceId)}
                  onClick={() => void switchWorkspace(workspace.id)}
                >
                  <span className="mobile-workspace-controls__name">{workspace.name}</span>
                  <span className="mobile-workspace-controls__status">
                    {switching ? '切换中…' : selected ? '当前' : ''}
                  </span>
                </button>
              )
            })}
          </section>
        )}
      </div>

      <div className="mobile-controls" data-open={navigationOpen || undefined}>
      {navigationOpen && (
        <button
          type="button"
          className="mobile-controls__backdrop"
          aria-label="关闭菜单"
          onClick={closeNavigation}
        />
      )}

      <div className="mobile-controls__pill" role="toolbar" aria-label="快捷操作">
        <button
          type="button"
          className="mobile-controls__quick-trigger"
          aria-label="打开历史会话"
          title="历史会话"
          onClick={() => navigateTo(routes.view.allSessions())}
        >
          <History aria-hidden="true" />
          <span>历史</span>
        </button>
        <button
          type="button"
          className="mobile-controls__quick-trigger"
          aria-label="刷新页面"
          title="刷新页面"
          onClick={() => {
            closeNavigation()
            window.CraftAgentAndroid?.reload()
          }}
        >
          <RefreshCw aria-hidden="true" />
          <span>刷新</span>
        </button>
        <button
          type="button"
          className="mobile-controls__quick-trigger mobile-controls__menu-trigger"
          aria-label={navigationOpen ? '关闭应用菜单' : '打开应用菜单'}
          title="菜单"
          aria-expanded={navigationOpen}
          aria-controls="mobile-controls-panel"
          onClick={() => setNavigationOpen(value => !value)}
        >
          {navigationOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
          <span>菜单</span>
        </button>
      </div>

      {navigationOpen && (
        <nav
          id="mobile-controls-panel"
          className="mobile-controls__panel"
          aria-label="应用菜单"
        >
          <div className="mobile-controls__header">
            <span>应用菜单</span>
            <button type="button" onClick={closeNavigation} aria-label="关闭菜单">
              <X aria-hidden="true" />
            </button>
          </div>

          {MOBILE_NAVIGATION_ITEMS.map(({ label, route, icon: Icon, subitem }) => (
            <button
              key={label}
              type="button"
              className={subitem ? 'mobile-controls__subitem' : undefined}
              onClick={() => navigateTo(route)}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}

          <div className="mobile-controls__separator" />
          <button
            type="button"
            onClick={() => {
              closeNavigation()
              window.CraftAgentAndroid?.configureServer()
            }}
          >
            <Server aria-hidden="true" />
            <span>服务器配置</span>
          </button>
        </nav>
      )}
      </div>
    </>
  )
}

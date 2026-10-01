import { useEffect, useRef, useState } from 'react'
import {
  Archive,
  Bot,
  ChevronDown,
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
function isAndroidApp() {
  return new URLSearchParams(window.location.search).get('embedded') === 'android'
    && Boolean(window.CraftAgentAndroid)
}

/** Keep the shared renderer sized to the currently visible browser viewport. */
export function useMobileAppViewport() {
  useEffect(() => {
    const root = document.documentElement
    const body = document.body
    const android = isAndroidApp()
    if (android) {
      root.dataset.mobileApp = 'android'
      body.dataset.mobileApp = 'android'
    }

    const updateViewport = () => {
      const viewport = window.visualViewport
      const height = Math.round(viewport?.height ?? window.innerHeight)
      root.style.setProperty('--app-viewport-height', `${height}px`)
      root.classList.toggle('keyboard-open', android && height < window.innerHeight - 120)
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
      if (android) {
        delete root.dataset.mobileApp
        delete body.dataset.mobileApp
      }
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

// Secondary destinations stay available without overwhelming the first view.
const MOBILE_NAVIGATION_GROUPS = MOBILE_NAVIGATION_ITEMS.reduce<MobileNavigationItem[][]>((groups, item) => {
  if (item.subitem || ['已标记', '已归档', '标签'].includes(item.label)) {
    groups[groups.length - 1]!.push(item)
  } else {
    groups.push([item])
  }
  return groups
}, [])

/**
 * Android app-bar controls. Workspace selection and grouped navigation live
 * above the shared page headers so page titles and back actions stay clear.
 */
export function MobileControls() {
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [switchingWorkspaceId, setSwitchingWorkspaceId] = useState<string | null>(null)
  const navigationRef = useRef<HTMLElement>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const android = isAndroidApp()

  useEffect(() => {
    if (!android || (!navigationOpen && !workspaceOpen)) return

    const root = document.documentElement
    const previousFocus = document.activeElement
    const panel = navigationOpen ? navigationRef.current : workspaceRef.current
    panel?.focus()
    const closeOverlays = () => {
      setNavigationOpen(false)
      setWorkspaceOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeOverlays()
      if (event.key !== 'Tab' || !panel) return
      const controls = Array.from(panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), summary, [tabindex="0"]',
      )).filter(element => element.getClientRects().length > 0)
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (!first || !last) {
        event.preventDefault()
        return
      }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) {
        event.preventDefault()
        first.focus()
      }
    }
    const handleAndroidBack = (event: Event) => {
      event.preventDefault()
      closeOverlays()
    }

    root.classList.add('mobile-overlay-open')
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('craft-agent-android-back', handleAndroidBack)
    return () => {
      root.classList.remove('mobile-overlay-open')
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('craft-agent-android-back', handleAndroidBack)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [android, navigationOpen, workspaceOpen])

  useEffect(() => {
    // Workspace discovery is not needed for the normal chat path. Defer the
    // two RPCs until the picker is actually opened to reduce startup work on
    // slower Android devices.
    if (!android || !workspaceOpen) return

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
  }, [android, workspaceOpen])

  if (!android) return null

  const dismissKeyboard = () => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement) activeElement.blur()
    window.CraftAgentAndroid?.dismissKeyboard()
  }

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
      <div className="mobile-app-bar" aria-label="TokenBird">
        <span className="mobile-app-bar__brand">TokenBird</span>
      </div>
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
            dismissKeyboard()
            setNavigationOpen(false)
            setWorkspaceOpen(value => !value)
          }}
        >
          <FolderKanban aria-hidden="true" />
        </button>

        {workspaceOpen && (
          <section
            ref={workspaceRef}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            id="mobile-workspace-controls-panel"
            className="mobile-workspace-controls__panel"
            aria-label="切换工作区"
          >
            <div className="mobile-workspace-controls__header">切换工作区</div>
            {workspaces.length === 0 && <p className="mobile-workspace-controls__empty">正在加载工作区…</p>}
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
          className="mobile-controls__quick-trigger mobile-controls__menu-trigger"
          aria-label={navigationOpen ? '关闭应用菜单' : '打开应用菜单'}
          title="菜单"
          aria-expanded={navigationOpen}
          aria-controls="mobile-controls-panel"
          onClick={() => {
            dismissKeyboard()
            setWorkspaceOpen(false)
            setNavigationOpen(value => !value)
          }}
        >
          {navigationOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>
      </div>

      {navigationOpen && (
        <section
          ref={navigationRef}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          id="mobile-controls-panel"
          className="mobile-controls__panel"
          aria-label="应用菜单"
        >
          <div className="mobile-controls__header">
            <span>
              <strong>TokenBird</strong>
              <small>你的 AI 工作空间</small>
            </span>
            <button type="button" onClick={closeNavigation} aria-label="关闭菜单">
              <X aria-hidden="true" />
            </button>
          </div>

          <nav aria-label="主要导航" className="mobile-controls__destinations">
            {MOBILE_NAVIGATION_GROUPS.map(([item, ...children]) => {
              if (!item) return null
              const Icon = item.icon
              const entry = (
                <button type="button" onClick={() => navigateTo(item.route)}>
                  <Icon aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              )
              return children.length ? (
                <div key={item.label} className="mobile-controls__group">
                  {entry}
                  <details>
                    <summary aria-label={`${item.label}分类`}><ChevronDown aria-hidden="true" /></summary>
                    <div className="mobile-controls__children">
                      {children.map(({ label, route, icon: ChildIcon }) => (
                        <button key={label} type="button" onClick={() => navigateTo(route)}>
                          <ChildIcon aria-hidden="true" /><span>{label}</span>
                        </button>
                      ))}
                    </div>
                  </details>
                </div>
              ) : <div key={item.label}>{entry}</div>
            })}
          </nav>

          <div className="mobile-controls__separator" />
          <button
            type="button"
            onClick={() => {
              closeNavigation()
              window.CraftAgentAndroid?.reload()
            }}
          >
            <RefreshCw aria-hidden="true" />
            <span>刷新页面</span>
          </button>
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
        </section>
      )}
      </div>
    </>
  )
}

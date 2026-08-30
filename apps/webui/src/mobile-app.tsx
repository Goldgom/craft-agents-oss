import { useEffect, useState } from 'react'
import { navigate, routes } from '../../electron/src/renderer/lib/navigate'

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

/**
 * Makes the shared desktop renderer behave predictably inside an Android
 * WebView. In particular, visualViewport gives us the usable height when the
 * software keyboard is open instead of relying on the often stale 100vh.
 */
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

/**
 * The native header is deliberately removed in fullscreen mode. This compact
 * menu keeps the app-level actions discoverable without taking
 * persistent vertical space away from chat.
 */
export function MobileAppMenu() {
  const [open, setOpen] = useState(false)
  const android = isAndroidApp()

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open])

  if (!android) return null

  const closeAndRun = (action: () => void) => {
    setOpen(false)
    action()
  }

  return (
    <div className="mobile-app-menu" data-open={open || undefined}>
      {open && (
        <button
          type="button"
          className="mobile-app-menu__backdrop"
          aria-label="关闭应用菜单"
          onClick={() => setOpen(false)}
        />
      )}
      <div className="mobile-app-menu__surface">
        <button
          type="button"
          className="mobile-app-menu__trigger"
          aria-label="应用菜单"
          aria-expanded={open}
          aria-controls="mobile-app-menu-panel"
          onClick={() => setOpen(value => !value)}
        >
          <span aria-hidden="true">⋮</span>
        </button>
        {open && (
          <div id="mobile-app-menu-panel" className="mobile-app-menu__panel" role="menu" aria-label="应用菜单">
            <button type="button" role="menuitem" onClick={() => closeAndRun(() => window.CraftAgentAndroid?.reload())}>
              刷新页面
            </button>
            <button type="button" role="menuitem" onClick={() => closeAndRun(() => window.CraftAgentAndroid?.configureServer())}>
              服务器配置
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

type MobileNavigationItem = {
  label: string
  route: Parameters<typeof navigate>[0]
}

const MOBILE_NAVIGATION_ITEMS: MobileNavigationItem[] = [
  { label: '全部会话', route: routes.view.allSessions() },
  { label: '已标记', route: routes.view.flagged() },
  { label: '已归档', route: routes.view.archived() },
  { label: '标签', route: routes.view.label('__all__') },
  { label: '数据源', route: routes.view.sources() },
  { label: '  API', route: routes.view.sourcesApi() },
  { label: '  MCP', route: routes.view.sourcesMcp() },
  { label: '  本地文件夹', route: routes.view.sourcesLocal() },
  { label: '工具', route: routes.view.tools() },
  { label: '  内置 CLI', route: routes.view.tools('builtin') },
  { label: '  自定义 CLI', route: routes.view.tools('custom') },
  { label: '技能', route: routes.view.skills() },
  { label: '项目', route: routes.view.projects() },
  { label: '自动化', route: routes.view.automations() },
  { label: '  定时自动化', route: routes.view.automationsScheduled() },
  { label: '  事件自动化', route: routes.view.automationsEvent() },
  { label: '  脚本监控', route: routes.view.automationsScriptMonitor() },
  { label: '  Agents', route: routes.view.automationsAgents() },
  { label: '设置', route: routes.view.settings() },
]

/**
 * Android-only navigation drawer. The desktop sidebar remains owned by
 * AppShell; this drawer is just a compact, always-discoverable way to reach
 * the same views when the desktop sidebar is hidden in compact mode.
 */
export function MobileNavigationMenu() {
  const [open, setOpen] = useState(false)
  const android = isAndroidApp()

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open])

  if (!android) return null

  return (
    <div className="mobile-navigation-menu" data-open={open || undefined}>
      {open && (
        <button
          type="button"
          className="mobile-navigation-menu__backdrop"
          aria-label="关闭导航栏"
          onClick={() => setOpen(false)}
        />
      )}
      <div className="mobile-navigation-menu__surface">
        <button
          type="button"
          className="mobile-navigation-menu__trigger"
          aria-label="打开导航栏"
          aria-expanded={open}
          aria-controls="mobile-navigation-menu-panel"
          onClick={() => setOpen(value => !value)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        {open && (
          <nav
            id="mobile-navigation-menu-panel"
            className="mobile-navigation-menu__panel"
            aria-label="应用导航"
          >
            <div className="mobile-navigation-menu__title">
              <span>应用导航</span>
              <button
                type="button"
                className="mobile-navigation-menu__close"
                aria-label="关闭导航栏"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
            {MOBILE_NAVIGATION_ITEMS.map(item => (
              <button
                key={`${item.label}-${item.route}`}
                type="button"
                onClick={() => {
                  setOpen(false)
                  navigate(item.route)
                }}
                className={item.label.startsWith('  ') ? 'mobile-navigation-menu__subitem' : undefined}
              >
                {item.label.trim()}
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  )
}

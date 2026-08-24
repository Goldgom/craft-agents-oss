import { useEffect, useState } from 'react'

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
 * menu keeps the two essential app-level actions discoverable without taking
 * persistent vertical space away from chat.
 */
export function MobileAppMenu() {
  const [open, setOpen] = useState(false)
  const android = isAndroidApp()

  if (!android) return null

  const closeAndRun = (action: () => void) => {
    setOpen(false)
    action()
  }

  return (
    <div className="mobile-app-menu" data-open={open || undefined}>
      {open && (
        <div className="mobile-app-menu__panel" role="menu" aria-label="应用菜单">
          <button type="button" role="menuitem" onClick={() => closeAndRun(() => window.CraftAgentAndroid?.reload())}>
            刷新页面
          </button>
          <button type="button" role="menuitem" onClick={() => closeAndRun(() => window.CraftAgentAndroid?.configureServer())}>
            服务器配置
          </button>
        </div>
      )}
      <button
        type="button"
        className="mobile-app-menu__trigger"
        aria-label="应用菜单"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span aria-hidden="true">⋮</span>
      </button>
    </div>
  )
}

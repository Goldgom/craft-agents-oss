/**
 * Web UI App — thin wrapper that:
 * 1. Fetches WS config from the server
 * 2. Creates the web API adapter + sets window.electronAPI
 * 3. Delegates to the Electron renderer's App component
 *
 * Mobile responsiveness is handled by container queries and isAutoCompact
 * in the shared renderer components — no webui-specific layout hacks needed.
 */

import React, { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { createWebApi } from './adapter/web-api'
import { MobileControls, useMobileAppViewport } from './mobile-app'
import type { WsRpcClient } from '../../electron/src/transport/client'

// Lazy-load the Electron App after window.electronAPI is set up.
// This prevents any Electron component from accessing window.electronAPI
// before the web adapter is ready.
const ElectronApp = lazy(() => import('@/App'))

type Phase = 'loading' | 'error' | 'ready'

function LoadingScreen() {
  const { t } = useTranslation()

  return (
    <div className="relative flex h-screen items-center justify-center overflow-hidden bg-background px-6 font-sans text-foreground">
      <div className="pointer-events-none absolute -top-24 left-1/2 size-72 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative flex w-full max-w-sm flex-col items-center rounded-3xl border border-border/60 bg-card/80 px-7 py-10 text-center shadow-modal-small">
        <img src="./icon-192.png" alt="" className="mb-5 size-16 rounded-2xl shadow-minimal" />
        <h1 className="text-xl font-semibold tracking-tight">TokenBird</h1>
        <div className="mt-5 size-7 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
        <p className="mt-4 text-sm text-muted-foreground">{t("webui.connectingToServer")}</p>
      </div>
    </div>
  )
}

function ErrorScreen({ message, onRetry, embedded }: { message: string; onRetry: () => void; embedded: boolean }) {
  const { t } = useTranslation()

  return (
    <div className="flex h-screen items-center justify-center bg-background px-6 font-sans text-foreground">
      <div className="w-full max-w-md rounded-3xl border border-border/60 bg-card px-6 py-8 text-center shadow-modal-small">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-destructive/10 text-xl text-destructive">!</div>
        <p className="text-lg font-semibold text-foreground">{t("webui.connectionFailed")}</p>
        <p className="mx-auto mt-2 max-w-sm break-words text-[13px] leading-relaxed text-muted-foreground">{message}</p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
        <button
          onClick={onRetry}
          className="min-h-11 rounded-xl bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-minimal"
        >
          {t("common.retry")}
        </button>
        {embedded && window.CraftAgentAndroid && (
          <button
            onClick={() => window.CraftAgentAndroid?.configureServer()}
            className="min-h-11 rounded-xl border border-border bg-background px-5 py-2 text-sm font-medium text-foreground"
          >
            {t("settings.server.title")}
          </button>
        )}
        {!embedded && (
          <button
            onClick={() => {
              fetch('/api/auth/logout', { method: 'POST' }).then(() => {
                window.location.href = '/login'
              })
            }}
            className="min-h-11 rounded-xl border border-border bg-background px-5 py-2 text-sm font-medium text-foreground"
          >
            {t("webui.logOut")}
          </button>
        )}
        </div>
      </div>
    </div>
  )
}

export default function App() {
  useMobileAppViewport()
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState('')
  const clientRef = useRef<WsRpcClient | null>(null)
  const initRef = useRef(false)
  const initialParams = new URLSearchParams(window.location.search)
  const embeddedPlatform = initialParams.get('embedded')
  const embedded = Boolean(initialParams.get('ws')) || embeddedPlatform === 'android'

  const initialize = async () => {
    setPhase('loading')
    setError('')

    try {
      // 1. Fetch WS URL from the server (cookie auth)
      const params = new URLSearchParams(window.location.search)
      let embeddedWsUrl = params.get('ws')
      let embeddedToken = params.get('token') ?? undefined
      let embeddedConnectionMode: 'local' | 'remote' | undefined
      if (params.get('embedded') === 'android') {
        const mobileConfigResponse = await fetch('/api/mobile-config', {
          credentials: 'same-origin',
          cache: 'no-store',
        })
        if (!mobileConfigResponse.ok) {
          throw new Error(`Failed to load Android server config: ${mobileConfigResponse.status}`)
        }
        const mobileConfig = await mobileConfigResponse.json() as {
          wsUrl?: string
          token?: string
          mode?: 'local' | 'remote'
        }
        embeddedWsUrl = mobileConfig.wsUrl ?? null
        embeddedToken = mobileConfig.token || undefined
        embeddedConnectionMode = mobileConfig.mode
      }
      let wsUrl = embeddedWsUrl ?? ''
      if (!wsUrl) {
        const configRes = await fetch('/api/config', { credentials: 'same-origin' })
      if (!configRes.ok) {
        if (configRes.status === 401) {
          // Session expired — redirect to login
          window.location.href = '/login'
          return
        }
        throw new Error(`Failed to fetch config: ${configRes.status}`)
      }

        const config = await configRes.json() as { wsUrl?: string }
        wsUrl = config.wsUrl ?? ''
      }
      if (!wsUrl) throw new Error('No WebSocket server URL configured')

      // 2. Determine workspace — check URL params first
      let workspaceId = params.get('workspace') ?? undefined

      // If no workspace in URL, fetch the default from the server
      // so we can include it in the WebSocket handshake
      if (!workspaceId && !embeddedWsUrl) {
        try {
          const wsRes = await fetch('/api/config/workspaces', { credentials: 'same-origin' })
          if (wsRes.ok) {
            const { defaultWorkspaceId } = await wsRes.json() as { defaultWorkspaceId?: string }
            if (defaultWorkspaceId) workspaceId = defaultWorkspaceId
          }
        } catch {
          // Non-fatal — workspace will be set via switchWorkspace later
        }
      }

      // 3. Create web API adapter
      // Destroy previous client on retry
      if (clientRef.current) {
        clientRef.current.destroy()
      }

      const { api, client } = createWebApi({
        serverUrl: wsUrl,
        workspaceId,
        token: embeddedToken,
        connectionMode: embeddedConnectionMode,
      })
      clientRef.current = client

      // 4. Set window.electronAPI — must happen before any Electron component mounts
      ;(window as any).electronAPI = api

      // 5. Connect the WebSocket client
      client.connect()

      setPhase('ready')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setPhase('error')
    }
  }

  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true
      initialize()
    }

    return () => {
      // Cleanup on unmount
      clientRef.current?.destroy()
    }
  }, [])

  if (phase === 'loading') return <LoadingScreen />
  if (phase === 'error') return <ErrorScreen message={error} onRetry={initialize} embedded={embedded} />

  return (
    <Suspense fallback={<LoadingScreen />}>
      <ElectronApp />
      <MobileControls />
    </Suspense>
  )
}

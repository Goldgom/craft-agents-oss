/**
 * ServerPickerPage — 启动服务选择页 (startup server picker).
 *
 * Rendered when the startup server location is "无服务" (none): the app starts
 * only the frontend without bootstrapping the local service, and this page
 * lets the user choose which service to enter for THIS launch:
 *   - 本机服务器 (local embedded server)
 *   - any configured remote server profile
 *
 * Selecting a service persists the choice and relaunches the app.
 */

import * as React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Cloud, HardDrive, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { RemoteServerProfileInfo } from '../../shared/types'

export default function ServerPickerPage() {
  const { t } = useTranslation()
  const [profiles, setProfiles] = useState<RemoteServerProfileInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.electronAPI
      .getRemoteServers()
      .then((list) => { if (alive) setProfiles(list) })
      .catch(() => { if (alive) setProfiles([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const selectServer = async (target: string) => {
    if (starting) return
    setStarting(target)
    try {
      // Relaunches the app with the chosen service — the window closes.
      await window.electronAPI.selectStartupServer(target)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('serverPicker.startFailed'))
      setStarting(null)
    }
  }

  const CardButton = ({ target, icon, title, subtitle, onSelect }: {
    target: string
    icon: React.ReactNode
    title: string
    subtitle: string
    onSelect: (target: string) => void
  }) => (
    <button
      type="button"
      disabled={starting !== null}
      onClick={() => onSelect(target)}
      className="w-full flex items-center gap-4 rounded-xl border border-border/50 bg-background px-5 py-4 text-left transition-colors hover:bg-foreground/5 disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <div className="shrink-0 h-10 w-10 rounded-lg bg-foreground/5 flex items-center justify-center text-foreground/70">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs text-foreground/50 truncate">{subtitle}</p>
      </div>
      {starting === target && <Loader2 className="h-4 w-4 animate-spin text-foreground/60 shrink-0" />}
    </button>
  )

  return (
    <div className="h-screen w-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-border/50 bg-background shadow-minimal p-8">
        <h1 className="text-xl font-semibold text-foreground text-center">
          {t('serverPicker.title')}
        </h1>
        <p className="mt-2 text-sm text-foreground/60 text-center">
          {t('serverPicker.description')}
        </p>

        <div className="mt-8 space-y-3">
          <CardButton
            target="local"
            icon={<HardDrive className="h-5 w-5" />}
            title={t('serverPicker.localServer')}
            subtitle={t('serverPicker.localServerDesc')}
            onSelect={selectServer}
          />

          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-foreground/40" />
            </div>
          ) : profiles.length > 0 ? (
            profiles.map((profile) => (
              <CardButton
                key={profile.id}
                target={profile.id}
                icon={<Cloud className="h-5 w-5" />}
                title={profile.name}
                subtitle={profile.url}
                onSelect={selectServer}
              />
            ))
          ) : (
            <p className="text-center text-xs text-foreground/40 py-4">
              {t('serverPicker.noProfiles')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

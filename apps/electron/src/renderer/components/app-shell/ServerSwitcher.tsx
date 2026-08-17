/**
 * ServerSwitcher — 当前运行服务端选择器 (menu-bar).
 *
 * Shows the currently running service (本机服务器 / remote server profile) and
 * lets the user switch services. Switching is restart-based: the choice is
 * persisted and the app relaunches pointing at the selected service.
 */

import * as React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Cloud, HardDrive, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { RemoteServerProfileInfo, StartupServerContext } from '../../../shared/types'

export function ServerSwitcher() {
  const { t } = useTranslation()
  const [context, setContext] = useState<StartupServerContext | null>(null)
  const [profiles, setProfiles] = useState<RemoteServerProfileInfo[]>([])
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    let alive = true
    void window.electronAPI.getStartupContext()
      .then((ctx) => { if (alive) setContext(ctx) })
      .catch(() => {})
    void window.electronAPI.getRemoteServers()
      .then((list) => { if (alive) setProfiles(list) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const mode = context?.mode ?? 'local'
  const label = mode === 'remote'
    ? (context?.profileName ?? context?.serverUrl ?? t('serverSwitcher.remoteServer'))
    : t('serverSwitcher.localServer')

  const switchTo = async (target: string) => {
    if (switching) return
    setSwitching(true)
    try {
      // Restart-based switch — the window closes on relaunch.
      await window.electronAPI.switchServer(target)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('serverSwitcher.switchFailed'))
      setSwitching(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={switching}
          className="h-[30px] px-3 rounded-[8px] border border-foreground/6 text-[13px] text-foreground/50 hover:bg-foreground/5 hover:text-foreground transition-colors cursor-pointer flex items-center gap-1.5 shrink-0 titlebar-no-drag disabled:opacity-60"
          aria-label={t('serverSwitcher.ariaLabel')}
        >
          {switching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : mode === 'remote' ? (
            <Cloud className="h-3.5 w-3.5" />
          ) : (
            <HardDrive className="h-3.5 w-3.5" />
          )}
          <span className="truncate max-w-[140px]">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs text-foreground/50">
          {t('serverSwitcher.chooseServer')}
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() => void switchTo('local')}
          disabled={switching}
        >
          <HardDrive className="h-3.5 w-3.5" />
          <span className="flex-1 truncate">{t('serverSwitcher.localServer')}</span>
          {mode === 'local' && <Check className="h-3.5 w-3.5 opacity-60" />}
        </DropdownMenuItem>
        {profiles.length > 0 && <DropdownMenuSeparator />}
        {profiles.map((profile) => (
          <DropdownMenuItem
            key={profile.id}
            onSelect={() => void switchTo(profile.id)}
            disabled={switching}
          >
            <Cloud className="h-3.5 w-3.5" />
            <span className="flex-1 truncate">{profile.name}</span>
            {mode === 'remote' && context?.profileId === profile.id && <Check className="h-3.5 w-3.5 opacity-60" />}
          </DropdownMenuItem>
        ))}
        {profiles.length === 0 && (
          <DropdownMenuItem disabled>
            <span className="text-xs text-foreground/40">{t('serverSwitcher.noProfiles')}</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

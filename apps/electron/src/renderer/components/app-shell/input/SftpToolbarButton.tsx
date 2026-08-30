import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Cloud, Download, FolderOpen, Settings2, Upload } from 'lucide-react'
import { toast } from 'sonner'

import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { SettingsInput } from '@/components/settings'
import { Spinner } from '@craft-agent/ui'
import type { RemoteServerProfileInfo, SftpTransferRequest } from '../../../../shared/types'

interface SftpToolbarButtonProps {
  compactMode?: boolean
  disabled?: boolean
}

type TransferDirection = SftpTransferRequest['direction']

function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/**
 * SFTP entry point for the chat toolbar.
 *
 * Remote workspaces keep only their WS connection details. The client-local
 * profile registry is therefore resolved by URL, while credentials remain in
 * the main process and are never exposed to the renderer.
 */
export function SftpToolbarButton({ compactMode = false, disabled = false }: SftpToolbarButtonProps) {
  const { t } = useTranslation()
  const appShellContext = useOptionalAppShellContext()
  const activeWorkspace = useMemo(() => {
    if (!appShellContext?.activeWorkspaceId) return null
    return appShellContext.workspaces.find((workspace) => workspace.id === appShellContext.activeWorkspaceId) ?? null
  }, [appShellContext?.activeWorkspaceId, appShellContext?.workspaces])
  const remoteUrl = activeWorkspace?.remoteServer?.url ?? null
  const [profile, setProfile] = useState<RemoteServerProfileInfo | null>(null)
  const [profilesLoading, setProfilesLoading] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [transferDirection, setTransferDirection] = useState<TransferDirection>('upload')
  const [transferOpen, setTransferOpen] = useState(false)

  const refreshProfile = useCallback(async () => {
    if (!remoteUrl || !window.electronAPI?.getRemoteServers) {
      setProfile(null)
      return
    }

    setProfilesLoading(true)
    try {
      const profiles = await window.electronAPI.getRemoteServers()
      const normalizedUrl = normalizeServerUrl(remoteUrl)
      setProfile(profiles.find((candidate) => normalizeServerUrl(candidate.url) === normalizedUrl) ?? null)
    } catch {
      setProfile(null)
    } finally {
      setProfilesLoading(false)
    }
  }, [remoteUrl])

  useEffect(() => {
    void refreshProfile()
  }, [refreshProfile])

  // The settings page can be used to enable SFTP while this chat stays open.
  // Refreshing when the menu opens makes that change available immediately.
  const handleMenuOpenChange = (open: boolean) => {
    setMenuOpen(open)
    if (open) void refreshProfile()
  }

  const openTransfer = (direction: TransferDirection) => {
    setMenuOpen(false)
    setTransferDirection(direction)
    setTransferOpen(true)
  }

  // The toolbar is a remote-mode affordance; local workspaces should retain
  // their existing, local-file toolbar without an extra SFTP control.
  if (!remoteUrl) return null

  const configured = profile?.sftp?.enabled === true
  const label = 'SFTP'

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            disabled={disabled || profilesLoading}
            className={cn(
              'input-toolbar-btn inline-flex items-center h-7 rounded-[6px] text-[13px] text-foreground transition-colors select-none shrink-0',
              compactMode ? 'px-1.5' : 'px-2 gap-1.5',
              'hover:bg-foreground/5 disabled:opacity-50 disabled:pointer-events-none',
              menuOpen && 'bg-foreground/5',
            )}
            title={t('settings.remoteServers.sftpEnabled')}
          >
            {profilesLoading ? <Spinner className="h-4 w-4" /> : <Cloud className="h-4 w-4" />}
            {!compactMode && <span>SFTP</span>}
          </button>
        </DropdownMenuTrigger>
        <StyledDropdownMenuContent side="top" align="start" sideOffset={8} className="min-w-[220px]">
          {configured ? (
            <>
              <StyledDropdownMenuItem onSelect={() => openTransfer('upload')}>
                <Upload className="h-4 w-4" />
                <span>{t('settings.remoteServers.sftpUpload')}</span>
              </StyledDropdownMenuItem>
              <StyledDropdownMenuItem onSelect={() => openTransfer('download')}>
                <Download className="h-4 w-4" />
                <span>{t('settings.remoteServers.sftpDownload')}</span>
              </StyledDropdownMenuItem>
            </>
          ) : (
            <>
              <div className="px-2.5 py-2 text-xs text-muted-foreground">
                {t('settings.remoteServers.sftpEnabledDesc')}
              </div>
              <StyledDropdownMenuItem onSelect={() => navigate(routes.view.settings('remoteServers'))}>
                <Settings2 className="h-4 w-4" />
                <span>{t('settings.remoteServers.sftpEnabled')}</span>
              </StyledDropdownMenuItem>
            </>
          )}
        </StyledDropdownMenuContent>
      </DropdownMenu>

      <SftpTransferDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        profile={configured ? profile : null}
        direction={transferDirection}
      />
    </>
  )
}

interface SftpTransferDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile: RemoteServerProfileInfo | null
  direction: TransferDirection
}

function SftpTransferDialog({ open, onOpenChange, profile, direction }: SftpTransferDialogProps) {
  const { t } = useTranslation()
  const [localPath, setLocalPath] = useState('')
  const [remotePath, setRemotePath] = useState('')
  const [transferring, setTransferring] = useState(false)

  useEffect(() => {
    if (!open) return
    setLocalPath('')
    setRemotePath('')
  }, [direction, open, profile?.id])

  const chooseLocalPath = async () => {
    if (direction === 'upload') {
      const path = await window.electronAPI.pickSftpUploadFile()
      if (path) {
        setLocalPath(path)
        setRemotePath((current) => current || path.split(/[\\/]/).pop() || '')
      }
      return
    }

    const name = remotePath.split('/').pop() || undefined
    const path = await window.electronAPI.pickSftpDownloadDestination(name)
    if (path) setLocalPath(path)
  }

  const handleTransfer = async () => {
    if (!profile || !localPath || !remotePath.trim()) return
    setTransferring(true)
    try {
      const result = await window.electronAPI.transferRemoteServerFile(profile.id, {
        direction,
        localPath,
        remotePath: remotePath.trim(),
      })
      toast.success(t('settings.remoteServers.transferSuccess', { bytes: result.bytes }))
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.remoteServers.transferFailed'))
    } finally {
      setTransferring(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!transferring) onOpenChange(next) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{direction === 'upload' ? t('settings.remoteServers.sftpUpload') : t('settings.remoteServers.sftpDownload')}</DialogTitle>
          <DialogDescription>{profile?.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <SettingsInput
            label={t('settings.remoteServers.localPath')}
            value={localPath}
            onChange={setLocalPath}
            disabled
            action={
              <Button variant="outline" size="icon" title={t('settings.remoteServers.chooseLocalPath')} onClick={() => void chooseLocalPath()}>
                <FolderOpen className="h-4 w-4" />
              </Button>
            }
          />
          <SettingsInput
            label={t('settings.remoteServers.remotePath')}
            value={remotePath}
            onChange={setRemotePath}
            placeholder="backups/file.zip"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={transferring}>{t('common.cancel')}</Button>
          <Button onClick={() => void handleTransfer()} disabled={transferring || !localPath || !remotePath.trim()}>
            {transferring ? <Spinner className="h-4 w-4" /> : direction === 'upload' ? <Upload className="h-4 w-4" /> : <Download className="h-4 w-4" />}
            <span className="ml-2">{direction === 'upload' ? t('settings.remoteServers.sftpUpload') : t('settings.remoteServers.sftpDownload')}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog'
import type { RemoteServerProfileInfo } from '../../shared/types'

/** Available before the local server boots; all persistence uses native IPC. */
export function RemoteServerCredentialRepair({ profile, onClose, onSaved }: {
  profile: RemoteServerProfileInfo | null
  onClose(): void
  onSaved(profile: RemoteServerProfileInfo): void
}) {
  const { t } = useTranslation()
  const [token, setToken] = useState('')
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { setToken(''); setPassword(''); setPassphrase('') }, [profile])
  const needsPassword = !!profile?.sftp?.hasPassword
    || !!(profile?.sftp?.enabled && profile.sftp.authMethod === 'password')
  const needsPassphrase = !!profile?.sftp?.hasPassphrase
  const canSave = !!profile && (!profile.hasToken || !!token.trim())
    && (!needsPassword || !!password) && (!needsPassphrase || !!passphrase)
  const save = async () => {
    if (!profile || !canSave || saving) return
    setSaving(true)
    try {
      const saved = await window.electronAPI.saveRemoteServer({
        id: profile.id, name: profile.name, url: profile.url, token: token.trim() || undefined,
        ...(profile.sftp ? { sftp: {
          enabled: profile.sftp.enabled, host: profile.sftp.host, port: profile.sftp.port,
          username: profile.sftp.username, authMethod: profile.sftp.authMethod,
          privateKeyPath: profile.sftp.privateKeyPath, remoteRoot: profile.sftp.remoteRoot,
          password: password || undefined, passphrase: passphrase || undefined,
        } } : {}),
      })
      if (!saved?.id) throw new Error('Server credentials were not saved')
      onSaved(saved)
    } catch {
      toast.error(t('settings.remoteServers.errors.save'))
    } finally { setSaving(false) }
  }
  const field = (id: string, label: string, value: string, onChange: (value: string) => void) => (
    <label htmlFor={id} className="block space-y-2 text-sm">
      <span>{label}</span>
      <input id={id} type="password" value={value} onChange={event => onChange(event.target.value)}
        autoComplete="new-password" disabled={saving} placeholder={t('serverPicker.enterSecret')}
        className="w-full rounded-md border border-border bg-background px-3 py-2" />
    </label>
  )
  return <Dialog open={!!profile} onOpenChange={open => { if (!open && !saving) onClose() }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t('serverPicker.repairTitle')}</DialogTitle>
        <DialogDescription>{t('serverPicker.repairDescription')}</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); void save() }}>
        <p className="break-all text-sm text-foreground/60">{profile?.name} · {profile?.url}</p>
        {field('repair-server-token', t('settings.remoteServers.tokenLabel'), token, setToken)}
        {needsPassword && field('repair-sftp-password', t('settings.remoteServers.sftpPassword'), password, setPassword)}
        {needsPassphrase && field('repair-sftp-passphrase', t('settings.remoteServers.sftpPassphrase'), passphrase, setPassphrase)}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={saving || !canSave}>{t('common.save')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

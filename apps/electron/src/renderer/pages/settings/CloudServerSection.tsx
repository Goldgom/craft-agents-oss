import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { CloudConfig, CloudDevice, CloudShare, CloudStatus } from '@craft-agent/shared/cloud'
import { DEFAULT_CLOUD_URL } from '@craft-agent/shared/cloud'
import { SettingsSection, SettingsCard, SettingsInputRow, SettingsToggle, SettingsRow } from '@/components/settings'
import { Button } from '@/components/ui/button'

export function CloudServerSection() {
  const { t } = useTranslation()
  const [config, setConfig] = useState<CloudConfig>()
  const [accounts, setAccounts] = useState<Array<{ slug: string; name: string }>>([])
  const [status, setStatus] = useState<CloudStatus>()
  const [devices, setDevices] = useState<CloudDevice[]>([])
  const [shares, setShares] = useState<CloudShare[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void Promise.all([window.electronAPI.getCloudConfig(), window.electronAPI.listLlmConnections()]).then(([settings, connections]) => {
      if (!active) return
      setConfig(settings)
      setAccounts(connections.filter(c => c.oauthProvider === 'tokennest').map(c => ({ slug: c.slug, name: c.name })))
    }).catch(err => { if (active) setError(String(err)) })
    const poll = () => { void window.electronAPI.getCloudStatus().then(value => { if (active) setStatus(value) }).catch(() => {}) }
    poll()
    const timer = setInterval(poll, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const refresh = useCallback(async () => {
    const [nextDevices, nextShares] = await Promise.all([window.electronAPI.listCloudDevices(), window.electronAPI.listCloudShares()])
    setDevices(nextDevices); setShares(nextShares)
  }, [])
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }
  const openDevice = async (device: CloudDevice) => {
    const grant = await window.electronAPI.connectCloudDevice(device.id)
    // Browser access also works on phones without installing TokenBird.
    const browserUrl = `${config!.serverUrl}/connect/${device.id}#ticket=${encodeURIComponent(grant.token)}`
    await window.electronAPI.openUrl(browserUrl)
  }
  return <SettingsSection title={t('cloud.title')} description={t('cloud.description')}>
    {config && <SettingsCard>
      <SettingsInputRow label={t('cloud.serverUrl')} value={config.serverUrl} onChange={serverUrl => setConfig({ ...config, serverUrl })} placeholder={DEFAULT_CLOUD_URL} />
      <SettingsRow label={t('cloud.account')}>
        <select className="max-w-[240px] rounded border bg-background p-2 text-sm" value={config.connectionSlug} onChange={event => setConfig({ ...config, connectionSlug: event.target.value })}>
          <option value="">{t('cloud.selectAccount')}</option>
          {accounts.map(account => <option key={account.slug} value={account.slug}>{account.name}</option>)}
        </select>
      </SettingsRow>
      <SettingsInputRow label={t('cloud.deviceName')} value={config.deviceName} onChange={deviceName => setConfig({ ...config, deviceName })} />
      <SettingsToggle label={t('cloud.enableRemote')} description={t('cloud.enableRemoteDescription')} checked={config.remoteEnabled} onCheckedChange={remoteEnabled => setConfig({ ...config, remoteEnabled })} />
      <SettingsRow label={t('cloud.status')}><span className="text-xs">{status?.connected ? t('cloud.online') : t('cloud.offline')}</span></SettingsRow>
      <div className="flex gap-2 px-4 py-3">
        <Button size="sm" disabled={busy} onClick={() => void run(async () => { await window.electronAPI.setCloudConfig(config); toast.success(t('cloud.saved')); setStatus(await window.electronAPI.getCloudStatus()) })}>{t('common.save')}</Button>
        <Button size="sm" variant="outline" disabled={busy || !config.connectionSlug} onClick={() => void run(refresh)}>{t('cloud.refresh')}</Button>
      </div>
    </SettingsCard>}
    {(error || status?.error) && <p className="text-xs text-destructive break-words">{error || status?.error}</p>}
    {devices.length > 0 && <SettingsCard>{devices.map(device => <SettingsRow key={device.id} label={device.name} description={device.online ? t('cloud.online') : t('cloud.offline')}>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy || !device.online} onClick={() => void run(() => openDevice(device))}>{t('cloud.openBrowser')}</Button>
        <Button size="sm" disabled={busy || !device.online} onClick={() => void run(async () => {
          const grant = await window.electronAPI.connectCloudDevice(device.id)
          const existing = (await window.electronAPI.getRemoteServers()).find(p => p.url === grant.url)
          const profile = await window.electronAPI.saveRemoteServer({ id: existing?.id, name: device.name, url: grant.url, token: grant.token })
          await window.electronAPI.switchServer(profile.id)
        })}>{t('cloud.connect')}</Button>
      </div>
    </SettingsRow>)}</SettingsCard>}
    {shares.length > 0 && <SettingsCard>{shares.map(share => <SettingsRow key={share.id} label={share.title}>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => void window.electronAPI.openUrl(share.url)}>{t('common.open')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { await window.electronAPI.revokeCloudShare(share.id); await refresh() })}>{t('cloud.revoke')}</Button>
      </div>
    </SettingsRow>)}</SettingsCard>}
  </SettingsSection>
}

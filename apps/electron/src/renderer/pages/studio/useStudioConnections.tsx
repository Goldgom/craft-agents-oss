import { useTranslation } from 'react-i18next'
import { WorkbenchSelect } from '@/components/ui/workbench-select'
import { useEffect, useMemo, useState } from 'react'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import { imageGroups, imageModels, isImageConnection, preferredImageGroup } from './image-connections'
import { mindMapGroupForModel, mindMapTextModels } from './mindmap-models'
import { useAppShellContext } from '@/context/AppShellContext'

const IMAGE_CONNECTION_KEY = 'tokenbird.studio.imageConnection'
const MINDMAP_CONNECTION_KEY = 'tokenbird.studio.mindmapConnection'
const CANVAS_ASSISTANT_CONNECTION_KEY = 'tokenbird.studio.canvasAssistantConnection'

function supportsMindMap(connection: LlmConnectionWithStatus): boolean {
  return connection.oauthProvider === 'tokennest' || connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint'
}

export function useStudioConnections(options: { image?: boolean; assistant?: boolean } = {}) {
  const { t } = useTranslation()
  const { workspaceDefaultLlmConnection } = useAppShellContext()
  const [connections, setConnections] = useState<LlmConnectionWithStatus[]>([])
  const [loaded, setLoaded] = useState(false)
  const [connectionSlug, setConnectionSlug] = useState(() => localStorage.getItem(options.image ? IMAGE_CONNECTION_KEY : options.assistant ? CANVAS_ASSISTANT_CONNECTION_KEY : MINDMAP_CONNECTION_KEY) ?? '')
  const [channelGroup, setChannelGroup] = useState('')
  const [model, setModel] = useState('')

  useEffect(() => {
    let alive = true
    const load = async () => {
      const items = await window.electronAPI.listLlmConnectionsWithStatus()
      if (alive) {
        setConnections(items); setLoaded(true)
        if (!options.image) {
          setConnectionSlug(current => {
            const compatible = items.filter(supportsMindMap)
            if (compatible.some(item => item.slug === current && item.isAuthenticated && mindMapTextModels(item).length)) return current
            return (compatible.find(item => item.slug === workspaceDefaultLlmConnection && item.isAuthenticated && mindMapTextModels(item).length)
              ?? compatible.find(item => item.isDefault && item.isAuthenticated && mindMapTextModels(item).length)
              ?? compatible.find(item => item.isAuthenticated && mindMapTextModels(item).length)
              ?? compatible.find(item => item.slug === current)
              ?? compatible.find(item => item.slug === workspaceDefaultLlmConnection && mindMapTextModels(item).length)
              ?? compatible.find(item => item.isDefault && mindMapTextModels(item).length)
              ?? compatible.find(item => mindMapTextModels(item).length)
              ?? compatible[0])?.slug ?? ''
          })
        }
      }
    }
    void load().catch(() => {})
    const stop = window.electronAPI.onLlmConnectionsChanged(() => { void load().catch(() => {}) })
    return () => { alive = false; stop() }
  }, [options.image, options.assistant, workspaceDefaultLlmConnection])

  const connection = useMemo(() => connections.find(item => item.slug === connectionSlug), [connections, connectionSlug])
  const groups = useMemo(() => connection && options.image ? imageGroups(connection) : [], [connection, options.image])
  const selectedGroup = groups.some(group => group.id === channelGroup) ? channelGroup : connection && options.image ? preferredImageGroup(connection) : ''
  const availableModels = useMemo(() => connection
    ? options.image ? imageModels(connection, selectedGroup) : mindMapTextModels(connection)
    : [], [connection, options.image, selectedGroup])
  const modelChannelGroup = connection && !options.image ? mindMapGroupForModel(connection, model) : ''

  useEffect(() => {
    if (!connection) return
    if (options.image && channelGroup !== selectedGroup) setChannelGroup(selectedGroup)
    if (!availableModels.includes(model)) setModel(!options.image && connection.defaultModel && availableModels.includes(connection.defaultModel)
      ? connection.defaultModel : availableModels[0] ?? '')
  }, [options.image, connection, channelGroup, selectedGroup, availableModels, model])

  function chooseConnection(slug: string) {
    setConnectionSlug(slug)
    setChannelGroup('')
    setModel('')
    const key = options.image ? IMAGE_CONNECTION_KEY : options.assistant ? CANVAS_ASSISTANT_CONNECTION_KEY : MINDMAP_CONNECTION_KEY
    if (slug) localStorage.setItem(key, slug)
    else localStorage.removeItem(key)
  }

  async function loginTokenNest() {
    let slug = connections.find(item => item.oauthProvider === 'tokennest')?.slug ?? 'tokennest'
    if (connections.some(item => item.slug === slug && item.oauthProvider !== 'tokennest')) {
      let suffix = 2
      while (connections.some(item => item.slug === `tokennest-${suffix}`)) suffix += 1
      slug = `tokennest-${suffix}`
    }
    const result = await window.electronAPI.startTokenNestOAuth(slug)
    if (!result.success) throw new Error(result.error || 'TokenNest login failed')
    const items = await window.electronAPI.listLlmConnectionsWithStatus()
    setConnections(items)
    chooseConnection(slug)
  }

  async function refresh() {
    if (connection?.oauthProvider === 'tokennest') {
      const result = await window.electronAPI.refreshLlmConnectionModels(connection.slug)
      if (!result.success) throw new Error(result.error || t('studio.refreshModelsFailed'))
    }
    setConnections(await window.electronAPI.listLlmConnectionsWithStatus())
  }

  return { connections, connection, connectionSlug, setConnectionSlug: chooseConnection, model, setModel, modelChannelGroup, channelGroup: selectedGroup, setChannelGroup, availableModels, groups, loaded, loginTokenNest, refresh }
}

export function StudioConnectionPicker({
  connections, connectionSlug, setConnectionSlug, model, setModel, image, channelGroup, setChannelGroup,
}: {
  connections: LlmConnectionWithStatus[]
  connectionSlug: string
  setConnectionSlug: (value: string) => void
  model: string
  setModel: (value: string) => void
  image?: boolean
  channelGroup?: string
  setChannelGroup?: (value: string) => void
}) {
  const { t } = useTranslation()
  const selected = connections.find(item => item.slug === connectionSlug)
  const suggested = selected ? image ? imageModels(selected, channelGroup) : mindMapTextModels(selected) : []
  const groups = image && selected ? imageGroups(selected) : []
  return (
    <div className="grid min-w-0 grid-cols-1 gap-2">
      <WorkbenchSelect value={connectionSlug} onValueChange={value => { setConnectionSlug(value); setModel('') }} aria-label={t('studio.chooseConnection')} options={[{ value: "", label: t('studio.chooseConnection') }, ...connections.filter(item => image ? isImageConnection(item) : supportsMindMap(item)).map(item =>
          ({ value: item.slug, label: <>{item.name}{item.isAuthenticated ? '' : t('studio.notSignedIn')}</> }))]} />
      {groups.length > 0 && <WorkbenchSelect className="w-full" value={channelGroup} onValueChange={value => { setChannelGroup?.(value); setModel('') }} aria-label={t('studio.imageGroup')} options={[...groups.map(group => ({ value: group.id, label: group.name }))]} />}
      {suggested.length > 0 ? <WorkbenchSelect className="w-full" placeholder={t(image ? 'studio.imageModel' : 'studio.textModel')} value={model} onValueChange={value => setModel(value)} aria-label={image ? t('studio.imageModel') : t('studio.textModel')} options={[...suggested.map(id => ({ value: id, label: id }))]} /> : <input className="h-9 min-w-0 w-full rounded-lg border border-input bg-background px-3 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30" value={model} onChange={event => setModel(event.target.value)} list={image ? 'studio-image-models' : 'studio-text-models'} placeholder={image ? t('studio.configureImageModel') : t('studio.textModel')} aria-label={image ? t('studio.imageModel') : t('studio.textModel')} />}
      <datalist id={image ? 'studio-image-models' : 'studio-text-models'}>{suggested.map(id => <option key={id} value={id} />)}</datalist>
    </div>
  )
}

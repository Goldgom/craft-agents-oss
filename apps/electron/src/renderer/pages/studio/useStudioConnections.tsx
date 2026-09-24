import { useEffect, useMemo, useState } from 'react'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import { imageGroups, imageModels, isImageConnection, preferredImageGroup } from './image-connections'
import { mindMapGroupForModel, mindMapTextModels } from './mindmap-models'
import { useAppShellContext } from '@/context/AppShellContext'

const IMAGE_CONNECTION_KEY = 'tokenbird.studio.imageConnection'
const MINDMAP_CONNECTION_KEY = 'tokenbird.studio.mindmapConnection'

function supportsMindMap(connection: LlmConnectionWithStatus): boolean {
  return connection.oauthProvider === 'tokennest' || connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint'
}

export function useStudioConnections(options: { image?: boolean } = {}) {
  const { workspaceDefaultLlmConnection } = useAppShellContext()
  const [connections, setConnections] = useState<LlmConnectionWithStatus[]>([])
  const [loaded, setLoaded] = useState(false)
  const [connectionSlug, setConnectionSlug] = useState(() => localStorage.getItem(options.image ? IMAGE_CONNECTION_KEY : MINDMAP_CONNECTION_KEY) ?? '')
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
            if (items.some(item => item.slug === current && supportsMindMap(item))) return current
            const compatible = items.filter(supportsMindMap)
            return (compatible.find(item => item.slug === workspaceDefaultLlmConnection && mindMapTextModels(item).length)
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
  }, [options.image, workspaceDefaultLlmConnection])

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
    const key = options.image ? IMAGE_CONNECTION_KEY : MINDMAP_CONNECTION_KEY
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
      if (!result.success) throw new Error(result.error || '刷新 TokenNest 模型和分组失败')
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
  const selected = connections.find(item => item.slug === connectionSlug)
  const suggested = selected ? image ? imageModels(selected, channelGroup) : mindMapTextModels(selected) : []
  const groups = image && selected ? imageGroups(selected) : []
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className="rounded border border-border bg-background px-2 py-1.5 text-sm" value={connectionSlug} onChange={event => { setConnectionSlug(event.target.value); setModel('') }} aria-label="AI connection">
        <option value="">选择连接</option>
        {connections.filter(item => image ? isImageConnection(item) : supportsMindMap(item)).map(item =>
          <option value={item.slug} key={item.slug}>{item.name}{item.isAuthenticated ? '' : '（未登录）'}</option>)}
      </select>
      {groups.length > 0 && <select className="min-w-32 rounded border border-border bg-background px-2 py-1.5 text-sm" value={channelGroup} onChange={event => { setChannelGroup?.(event.target.value); setModel('') }} aria-label="图片生成分组">
        {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select>}
      {suggested.length > 0 ? <select className="min-w-36 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm" value={model} onChange={event => setModel(event.target.value)} aria-label={image ? '图像模型' : '文本模型'}>
        {suggested.map(id => <option key={id} value={id}>{id}</option>)}
      </select> : <input className="min-w-36 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm" value={model} onChange={event => setModel(event.target.value)} list={image ? 'studio-image-models' : 'studio-text-models'} placeholder={image ? '先在设置中配置图像模型' : '文本模型'} aria-label="Model" />}
      <datalist id={image ? 'studio-image-models' : 'studio-text-models'}>{suggested.map(id => <option key={id} value={id} />)}</datalist>
    </div>
  )
}

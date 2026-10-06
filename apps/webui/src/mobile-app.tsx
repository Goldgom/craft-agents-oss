import { useEffect, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import {
  Archive, Bot, ChevronDown, Clock, Database, FileCode, Flag, FolderKanban,
  FolderOpen, History, Menu, MessageCircle, MonitorCog, MousePointerClick,
  PlugZap, RefreshCw, Search, Server, Settings, Sparkles, SquarePen, Tag,
  Moon, Sun, Wrench, X, Zap, FileText, Columns3, Palette, GitBranch, BarChart3,
} from 'lucide-react'
import { navigate, routes } from '../../electron/src/renderer/lib/navigate'
import { activeSessionIdAtom, sessionMetaMapAtom, windowWorkspaceIdAtom, type SessionMeta } from '../../electron/src/renderer/atoms/sessions'
import type { Workspace } from '../../electron/src/shared/types'
import { useTheme } from '../../electron/src/renderer/context/ThemeContext'
import { installAndroidDownloads } from './adapter/browser-files'
import { toast } from 'sonner'

function isAndroidApp() {
  return new URLSearchParams(window.location.search).get('embedded') === 'android'
    && Boolean(window.CraftAgentAndroid)
}

/** Keep the shared renderer sized to the visible viewport, including the IME. */
export function useMobileAppViewport() {
  useEffect(() => {
    const root = document.documentElement
    const android = isAndroidApp()
    const removeDownloads = android ? installAndroidDownloads() : () => {}
    const onFileError = (event: Event) => toast.error((event as CustomEvent<string>).detail)
    window.addEventListener('craft-agent:file-error', onFileError)
    if (android) {
      root.dataset.mobileApp = 'android'
      document.body.dataset.mobileApp = 'android'
    }
    // Sync the effective theme, including settings and system preference changes.
    const syncNativeTheme = () => {
      if (android) window.CraftAgentAndroid?.setDarkTheme?.(root.classList.contains('dark'))
    }
    const themeObserver = new MutationObserver(syncNativeTheme)
    if (android) themeObserver.observe(root, { attributes: true, attributeFilter: ['class'] })
    syncNativeTheme()
    const updateViewport = () => {
      const height = Math.round(window.visualViewport?.height ?? window.innerHeight)
      root.style.setProperty('--app-viewport-height', `${height}px`)
      root.style.setProperty('--app-viewport-top', `${window.visualViewport?.offsetTop ?? 0}px`)
      root.classList.toggle('keyboard-open', android && height < window.innerHeight - 120)
    }
    // Use Radix's Escape path so only its top layer closes and callers retain
    // their pending/unsaved-change guards. Capture before navigation handlers.
    const dismissAndroidDialog = (event: Event) => {
      if (!android || event.defaultPrevented) return
      const dialogs = [...document.querySelectorAll<HTMLElement>(
        '[data-slot="dialog-content"], [data-slot="drawer-content"], [data-fullscreen-overlay]'
      )].filter(dialog => dialog.dataset.state !== 'closed' && dialog.getClientRects().length > 0)
      if (!dialogs.length) return
      event.preventDefault()
      event.stopImmediatePropagation()
      dialogs[dialogs.length - 1].dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
      }))
    }
    window.addEventListener('craft-agent-android-back', dismissAndroidDialog, true)
    updateViewport()
    window.addEventListener('resize', updateViewport)
    window.visualViewport?.addEventListener('resize', updateViewport)
    window.visualViewport?.addEventListener('scroll', updateViewport)
    return () => {
      removeDownloads()
      window.removeEventListener('craft-agent:file-error', onFileError)
      window.removeEventListener('craft-agent-android-back', dismissAndroidDialog, true)
      themeObserver.disconnect()
      window.removeEventListener('resize', updateViewport)
      window.visualViewport?.removeEventListener('resize', updateViewport)
      window.visualViewport?.removeEventListener('scroll', updateViewport)
      root.style.removeProperty('--app-viewport-height')
      root.style.removeProperty('--app-viewport-top')
      root.classList.remove('keyboard-open')
      if (android) {
        delete root.dataset.mobileApp
        delete document.body.dataset.mobileApp
      }
    }
  }, [])
}

type Route = Parameters<typeof navigate>[0]
type Destination = { label: string; route: Route; icon: typeof History }
const PRIMARY_DESTINATIONS: Destination[] = [
  { label: '会话看板', route: routes.view.board(), icon: Columns3 },
  { label: '页面库', route: routes.view.pages(), icon: FileText },
  { label: '定时任务', route: routes.view.automationsScheduled(), icon: Clock },
  { label: '技能', route: routes.view.skills(), icon: Sparkles },
  { label: '连接器 · 数据源', route: routes.view.sources(), icon: Database },
  { label: '项目', route: routes.view.projects(), icon: FolderKanban },
]
const MORE_DESTINATIONS: Destination[] = [
  { label: '用量统计', route: routes.view.settings('usage'), icon: BarChart3 },
  { label: '账户与充值', route: routes.view.settings('recharge'), icon: Sparkles },
  { label: '消息集成', route: routes.view.settings('messaging'), icon: MessageCircle },
  { label: '历史会话', route: routes.view.allSessions(), icon: History },
  { label: '已标记', route: routes.view.flagged(), icon: Flag },
  { label: '已归档', route: routes.view.archived(), icon: Archive },
  { label: '标签', route: routes.view.label('__all__'), icon: Tag },
  { label: '全部自动化', route: routes.view.automations(), icon: Zap },
  { label: '事件自动化', route: routes.view.automationsEvent(), icon: MousePointerClick },
  { label: '脚本监控', route: routes.view.automationsScriptMonitor(), icon: MonitorCog },
  { label: '智能体', route: routes.view.automationsAgents(), icon: Bot },
  { label: 'API 连接器', route: routes.view.sourcesApi(), icon: PlugZap },
  { label: 'MCP 连接器', route: routes.view.sourcesMcp(), icon: PlugZap },
  { label: '本地文件夹', route: routes.view.sourcesLocal(), icon: FolderOpen },
  { label: '工具', route: routes.view.tools(), icon: Wrench },
  { label: '内置 CLI', route: routes.view.tools('builtin'), icon: FileCode },
  { label: '自定义 CLI', route: routes.view.tools('custom'), icon: FileCode },
]

function sessionTitle(session: SessionMeta) {
  return session.name || session.preview || '新对话'
}

/** Subscribe to session metadata only while the drawer is visible. */
function DrawerSessions({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const sessions = useAtomValue(sessionMetaMapAtom)
  const workspaceId = useAtomValue(windowWorkspaceIdAtom)
  const activeId = useAtomValue(activeSessionIdAtom)
  const [query, setQuery] = useState('')
  const eligible = [...sessions.values()]
    .filter(session => session.workspaceId === workspaceId && !session.hidden && !session.isArchived && !session.parentSessionId && !session.taskDraft)
    // Creation time and a draft name do not make a conversation history.
    // Preview/final-message evidence also supports older metadata without counts.
    .filter(session => (session.messageCount ?? 0) > 0 || Boolean(session.preview?.trim()) || Boolean(session.lastFinalMessageId))
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt ?? 0) - (a.lastMessageAt ?? a.createdAt ?? 0))
  const filtered = eligible.filter(session => sessionTitle(session).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const pinned = filtered.filter(session => session.isFlagged)
  const recent = filtered.filter(session => !session.isFlagged)
  const renderSession = (session: SessionMeta) => (
    <button key={session.id} type="button" className={`mobile-drawer__session${session.id === activeId ? ' is-active' : ''}`} aria-current={session.id === activeId ? 'page' : undefined} onClick={() => onNavigate(routes.view.allSessions(session.id))}>
      <span className="mobile-drawer__session-icon"><MessageCircle aria-hidden="true" /></span>
      <span>{sessionTitle(session)}</span>
      {session.isProcessing && <span className="mobile-drawer__busy" aria-label="正在回复" />}
    </button>
  )
  return (
    <div className="mobile-drawer__history">
      <label className="mobile-drawer__search"><Search aria-hidden="true" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索对话" aria-label="搜索当前工作区对话" /></label>
      {pinned.length > 0 && <><h2>置顶</h2>{pinned.slice(0, 8).map(renderSession)}</>}
      <div className="mobile-drawer__section-heading"><h2>{query.trim() ? '搜索结果' : '最近'}</h2><button type="button" onClick={() => onNavigate(routes.view.allSessions())}>全部</button></div>
      {recent.slice(0, 24).map(renderSession)}
      {filtered.length === 0 && <p className="mobile-drawer__empty">{query.trim() ? '没有找到相关对话' : '还没有历史对话，发送消息后会显示在这里'}</p>}
    </div>
  )
}

export function MobileControls({ connectionMode }: { connectionMode: 'local' | 'remote' }) {
  const { isDark, setMode } = useTheme()
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [switchingWorkspaceId, setSwitchingWorkspaceId] = useState<string | null>(null)
  const [workspaceError, setWorkspaceError] = useState('')
  const [newWorkspaceName, setNewWorkspaceName] = useState('')
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const [modelSetupNeeded, setModelSetupNeeded] = useState(false)
  const [modelNoticeDismissed, setModelNoticeDismissed] = useState(false)
  const [studioMode, setStudioMode] = useState('agent')
  const sessionMetadata = useAtomValue(sessionMetaMapAtom)
  const activeWorkspaceId = useAtomValue(windowWorkspaceIdAtom)
  const navigationRef = useRef<HTMLElement>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const android = isAndroidApp()
  const modeLabel = connectionMode === 'remote' ? '服务器模式' : '本机聊天'
  const closeOverlays = () => { setNavigationOpen(false); setWorkspaceOpen(false) }
  const dismissKeyboard = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    window.CraftAgentAndroid?.dismissKeyboard()
  }
  const navigateTo = (route: Route) => {
    closeOverlays()
    window.dispatchEvent(new CustomEvent('craft-agent:studio-mode', { detail: 'agent' }))
    navigate(route, { skipAutoSelect: true })
  }
  const openStudio = (mode: string) => {
    closeOverlays(); dismissKeyboard()
    window.dispatchEvent(new CustomEvent('craft-agent:studio-mode', { detail: mode }))
  }
  useEffect(() => {
    const changed = (event: Event) => setStudioMode((event as CustomEvent<string>).detail)
    window.addEventListener('craft-agent:studio-mode-changed', changed)
    return () => window.removeEventListener('craft-agent:studio-mode-changed', changed)
  }, [])
  useEffect(() => {
    if (android) window.CraftAgentAndroid?.setTaskRunning?.([...sessionMetadata.values()].some(session => session.isProcessing))
  }, [android, sessionMetadata])
  useEffect(() => {
    if (!android || studioMode === 'agent') return
    const backToChat = (event: Event) => {
      if (event.defaultPrevented || navigationOpen || workspaceOpen || document.querySelector('[role="dialog"]')) return
      event.preventDefault(); openStudio('agent')
    }
    window.addEventListener('craft-agent-android-back', backToChat)
    return () => window.removeEventListener('craft-agent-android-back', backToChat)
  }, [android, studioMode, navigationOpen, workspaceOpen])

  useEffect(() => {
    if (!android || (!navigationOpen && !workspaceOpen)) return
    const previousFocus = document.activeElement
    const panel = navigationOpen ? navigationRef.current : workspaceRef.current
    panel?.focus()
    const close = () => { setNavigationOpen(false); setWorkspaceOpen(false) }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
      if (event.key !== 'Tab' || !panel) return
      const controls = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), input, summary, [tabindex="0"]')).filter(element => element.getClientRects().length > 0)
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (!first || !last) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first.focus() }
    }
    const handleBack = (event: Event) => { event.preventDefault(); close() }
    document.documentElement.classList.add('mobile-overlay-open')
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('craft-agent-android-back', handleBack)
    return () => {
      document.documentElement.classList.remove('mobile-overlay-open')
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('craft-agent-android-back', handleBack)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [android, navigationOpen, workspaceOpen])

  useEffect(() => {
    if (!android || !workspaceOpen) return
    let cancelled = false
    setWorkspaceError('')
    window.electronAPI.getWorkspaces().then(available => { if (!cancelled) setWorkspaces(available) }).catch(error => {
      console.error('[MobileControls] Failed to load workspaces:', error)
      if (!cancelled) setWorkspaceError('工作区加载失败，请关闭后重试')
    })
    return () => { cancelled = true }
  }, [android, workspaceOpen])

  useEffect(() => {
    if (!android || connectionMode !== 'local') return
    let cancelled = false
    const refresh = () => {
      void window.electronAPI.listLlmConnectionsWithStatus().then(connections => {
        if (!cancelled) setModelSetupNeeded(!connections.some(connection => connection.isAuthenticated))
      }).catch(error => console.error('[MobileControls] Failed to check model setup:', error))
    }
    refresh()
    const unsubscribe = window.electronAPI.onLlmConnectionsChanged(refresh)
    return () => { cancelled = true; unsubscribe() }
  }, [android, connectionMode])

  const showModelNotice = android && connectionMode === 'local' && modelSetupNeeded && !modelNoticeDismissed
  useEffect(() => {
    document.documentElement.classList.toggle('mobile-model-setup-needed', showModelNotice)
    return () => document.documentElement.classList.remove('mobile-model-setup-needed')
  }, [showModelNotice])

  if (!android) return null
  const openWorkspace = () => { dismissKeyboard(); setNavigationOpen(false); setWorkspaceOpen(value => !value) }
  const switchWorkspace = async (workspaceId: string) => {
    if (workspaceId === activeWorkspaceId || switchingWorkspaceId) return
    setSwitchingWorkspaceId(workspaceId)
    try {
      await window.electronAPI.switchWorkspace(workspaceId)
      const url = new URL(window.location.href)
      url.searchParams.set('workspace', workspaceId)
      // Do not carry a session or page from the previous workspace.
      for (const key of ['session', 'sessionId', 'route', 'panels', 'sidebar']) url.searchParams.delete(key)
      window.location.assign(url.toString())
    } catch (error) {
      console.error('[MobileControls] Failed to switch workspace:', error)
      setWorkspaceError('切换失败，请重试')
      setSwitchingWorkspaceId(null)
    }
  }

  return (
    <>
      <header className="mobile-app-bar" aria-label="词元鸟">
        <button type="button" className="mobile-app-bar__icon" aria-label="打开应用菜单" aria-expanded={navigationOpen} aria-controls="mobile-controls-panel" onClick={() => { dismissKeyboard(); setWorkspaceOpen(false); setNavigationOpen(value => !value) }}><Menu aria-hidden="true" /></button>
        <button type="button" className="mobile-app-bar__title" aria-label="切换工作区" aria-expanded={workspaceOpen} aria-controls="mobile-workspace-controls-panel" onClick={openWorkspace}><span>{studioMode === 'canvas' ? '画布' : studioMode === 'mindmap' ? '思维导图' : studioMode === 'super-agent' ? '超级智能体' : '词元鸟'} <ChevronDown aria-hidden="true" /></span><small><i className={connectionMode === 'remote' ? 'is-remote' : ''} />{modeLabel}</small></button>
        <button type="button" className="mobile-app-bar__icon" aria-label="新建对话" onClick={() => navigateTo(routes.action.newSession())}><SquarePen aria-hidden="true" /></button>
      </header>
      {showModelNotice && <aside className="mobile-model-notice" aria-label="模型连接提示">
        <span>连接模型，即可开始对话</span>
        <button type="button" onClick={() => navigateTo(routes.view.settings('ai'))}>去连接</button>
        <button type="button" className="mobile-model-notice__dismiss" aria-label="稍后连接模型" onClick={() => setModelNoticeDismissed(true)}><X aria-hidden="true" /></button>
      </aside>}
      {navigationOpen && <div className="mobile-drawer">
        <button type="button" className="mobile-overlay-backdrop" aria-label="关闭菜单" onClick={closeOverlays} />
        <section ref={navigationRef} id="mobile-controls-panel" className="mobile-drawer__panel" role="dialog" aria-modal="true" aria-label="应用菜单" tabIndex={-1}>
          <div className="mobile-drawer__header"><strong>词元鸟</strong><button type="button" aria-label="关闭菜单" onClick={closeOverlays}><X aria-hidden="true" /></button></div>
          <div className="mobile-drawer__scroll">
            <button type="button" className="mobile-drawer__new" onClick={() => navigateTo(routes.action.newSession())}><SquarePen aria-hidden="true" /><span>开启新对话</span></button>
            <nav className="mobile-drawer__destinations" aria-label="常用功能">
              <div className="mobile-drawer__studio" aria-label="创作工具">
                {[{ mode: 'canvas', label: '画布', Icon: Palette }, { mode: 'mindmap', label: '思维导图', Icon: GitBranch }, { mode: 'super-agent', label: '超级智能体', Icon: Bot }].map(({ mode, label, Icon }) => <button key={mode} type="button" aria-pressed={studioMode === mode} onClick={() => openStudio(mode)}><Icon aria-hidden="true" /><span>{label}</span></button>)}
              </div>
              {PRIMARY_DESTINATIONS.map(({ label, route, icon: Icon }) => <button key={label} type="button" onClick={() => navigateTo(route)}><Icon aria-hidden="true" /><span>{label}</span></button>)}
              <details className="mobile-drawer__more"><summary>更多功能 <ChevronDown aria-hidden="true" /></summary>{MORE_DESTINATIONS.map(({ label, route, icon: Icon }) => <button key={label} type="button" onClick={() => navigateTo(route)}><Icon aria-hidden="true" /><span>{label}</span></button>)}</details>
            </nav>
            <DrawerSessions onNavigate={navigateTo} />
          </div>
          <footer className="mobile-drawer__footer">
            <button type="button" className="mobile-drawer__mode" onClick={() => { closeOverlays(); window.CraftAgentAndroid?.configureServer() }}><Server aria-hidden="true" /><span><strong>{modeLabel}</strong><small>切换本机 / 服务器</small></span><ChevronDown aria-hidden="true" /></button>
            <div className="mobile-drawer__footer-actions">
              <button type="button" onClick={openWorkspace}><FolderKanban aria-hidden="true" /><span>工作区</span></button>
              <button type="button" onClick={() => navigateTo(routes.view.settings())}><Settings aria-hidden="true" /><span>设置</span></button>
              <button type="button" aria-label={isDark ? '切换浅色模式' : '切换深色模式'} onClick={() => setMode(isDark ? 'light' : 'dark')}>{isDark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}<span>{isDark ? '浅色' : '深色'}</span></button>
              <button type="button" onClick={() => { closeOverlays(); window.CraftAgentAndroid?.reload() }}><RefreshCw aria-hidden="true" /><span>刷新</span></button>
            </div>
          </footer>
        </section>
      </div>}
      {workspaceOpen && <div className="mobile-workspace-picker">
        <button type="button" className="mobile-overlay-backdrop" aria-label="关闭工作区列表" onClick={closeOverlays} />
        <section ref={workspaceRef} role="dialog" aria-modal="true" tabIndex={-1} id="mobile-workspace-controls-panel" className="mobile-workspace-picker__panel" aria-label="切换工作区">
          <div className="mobile-drawer__header"><strong>切换工作区</strong><button type="button" onClick={closeOverlays} aria-label="关闭工作区列表"><X aria-hidden="true" /></button></div>
          {workspaceError && <p className="mobile-drawer__empty" role="alert">{workspaceError}</p>}
          {!workspaceError && workspaces.length === 0 && <p className="mobile-drawer__empty">正在加载工作区…</p>}
          {workspaces.map(workspace => <button key={workspace.id} type="button" className={`mobile-workspace-picker__item${workspace.id === activeWorkspaceId ? ' is-active' : ''}`} disabled={Boolean(switchingWorkspaceId)} onClick={() => workspace.id === activeWorkspaceId ? closeOverlays() : void switchWorkspace(workspace.id)}><FolderKanban aria-hidden="true" /><span>{workspace.name}</span><small>{workspace.id === switchingWorkspaceId ? '切换中…' : workspace.id === activeWorkspaceId ? '当前' : ''}</small></button>)}
          <form className="mobile-workspace-picker__create" onSubmit={async event => {
            event.preventDefault(); if (!newWorkspaceName.trim() || creatingWorkspace) return
            setCreatingWorkspace(true); setWorkspaceError('')
            try { const workspace = await window.electronAPI.createServerWorkspace(newWorkspaceName.trim()); setNewWorkspaceName(''); await switchWorkspace(workspace.id) }
            catch (error) { setWorkspaceError(error instanceof Error ? error.message : '创建工作区失败') }
            finally { setCreatingWorkspace(false) }
          }}><input aria-label="新工作区名称" placeholder="新工作区名称" value={newWorkspaceName} onChange={event => setNewWorkspaceName(event.target.value)} maxLength={80} /><button type="submit" disabled={creatingWorkspace || !newWorkspaceName.trim()}>{creatingWorkspace ? '创建中…' : '创建'}</button></form>
        </section>
      </div>}
    </>
  )
}

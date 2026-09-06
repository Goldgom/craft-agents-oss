import * as React from 'react'
import { RefreshCw, Users, Circle, ClipboardList, File } from 'lucide-react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppShellContext } from '@/context/AppShellContext'
import { getSessionTitle } from '@/utils/session'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { CollaborationGroup } from '@craft-agent/shared/protocol'

export const meta: DetailsPageMeta = { navigator: 'settings', slug: 'collaborations' }

type SessionLike = { id: string; workspaceId?: string; isProcessing?: boolean; name?: string; preview?: string }

export default function CollaborationManagementPage() {
  const { activeWorkspaceId } = useAppShellContext()
  const [groups, setGroups] = React.useState<CollaborationGroup[]>([])
  const [sessions, setSessions] = React.useState<SessionLike[]>([])
  const [loading, setLoading] = React.useState(true)
  const refresh = React.useCallback(async () => {
    if (!activeWorkspaceId) return
    setLoading(true)
    try {
      const [nextGroups, nextSessions] = await Promise.all([
        window.electronAPI.listCollaborations(activeWorkspaceId),
        window.electronAPI.getSessions() as Promise<SessionLike[]>,
      ])
      setGroups(nextGroups)
      setSessions(nextSessions)
    } finally { setLoading(false) }
  }, [activeWorkspaceId])
  React.useEffect(() => { void refresh() }, [refresh])
  React.useEffect(() => window.electronAPI.onCollaborationChanged(() => { void refresh() }), [refresh])
  const sessionMap = React.useMemo(() => new Map(sessions.map(s => [s.id, s])), [sessions])
  return <div className="flex h-full min-h-0 flex-col">
    <PanelHeader title="Collaboration management" actions={<Button variant="ghost" size="icon" onClick={() => void refresh()} disabled={loading} aria-label="Refresh"><RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} /></Button>} />
    <ScrollArea className="min-h-0 flex-1"><div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-6">
      <div className="rounded-lg border border-foreground/10 bg-background/50 p-4 text-sm text-muted-foreground">正在协作的会话会在这里显示。主会话负责协调，副会话只能向主会话报告。</div>
      {!groups.length && !loading && <div className="rounded-lg border border-dashed border-foreground/15 p-10 text-center text-sm text-muted-foreground"><Users className="mx-auto mb-2 size-8 opacity-50" />当前没有协作组</div>}
      {groups.map(group => <section key={group.id} className="rounded-lg border border-foreground/10 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-medium">协作组 {group.id}</h2><p className="text-xs text-muted-foreground">Revision {group.revision} · 更新于 {new Date(group.updatedAt).toLocaleString()}</p></div><span className="rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-600">Active</span></div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">{group.members.map(member => { const session = sessionMap.get(member.sessionId); const title = session ? getSessionTitle(session as never) : (member.name ?? member.sessionId); return <div key={member.id} className="rounded-md border border-foreground/10 p-3"><div className="flex items-center gap-2"><Circle className={`size-2.5 ${session ? 'fill-emerald-500 text-emerald-500' : 'fill-muted text-muted-foreground'}`} /><span className="font-medium">{title}</span><span className="ml-auto text-xs text-muted-foreground">{member.role === 'primary' ? '主会话' : '副会话'}</span></div><p className="mt-1 truncate text-xs text-muted-foreground">{member.workspaceId}{member.serverUrl ? ` · ${member.serverUrl}` : ''}{session?.isProcessing ? ' · 处理中' : ''}</p></div> })}</div>
        <div className="mt-4 flex gap-4 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1"><ClipboardList className="size-3.5" />共享数据板 {Object.keys(group.board).length}</span><span className="inline-flex items-center gap-1"><File className="size-3.5" />共享文件 {Object.keys(group.files).length}</span><span>事件 {group.events.length}</span></div>
      </section>)}
    </div></ScrollArea>
  </div>
}

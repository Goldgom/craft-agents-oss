import * as React from 'react'
import { Globe2, Plus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { SessionMeta } from '@/atoms/sessions'
import { getSessionTitle } from '@/utils/session'

type RemoteMember = { id: string; sessionId: string; workspaceId: string; serverUrl: string; name?: string }

export function CollaborationDialog({ primary, open, onOpenChange }: { primary: SessionMeta; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [sessions, setSessions] = React.useState<SessionMeta[]>([])
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [remoteMembers, setRemoteMembers] = React.useState<RemoteMember[]>([])
  const [remote, setRemote] = React.useState({ serverUrl: '', workspaceId: '', sessionId: '', name: '' })
  const [saving, setSaving] = React.useState(false)
  React.useEffect(() => {
    if (!open) return
    setSelected(new Set()); setRemoteMembers([]); setRemote({ serverUrl: '', workspaceId: '', sessionId: '', name: '' })
    void window.electronAPI.listCollaborationCandidates().then((items: SessionMeta[]) => setSessions(items.filter(item => item.id !== primary.id && !item.isArchived))).catch(error => toast.error(error instanceof Error ? error.message : 'Unable to load sessions'))
  }, [open, primary.id])
  const addRemote = () => {
    const serverUrl = remote.serverUrl.trim().replace(/\/$/, ''); const workspaceId = remote.workspaceId.trim(); const sessionId = remote.sessionId.trim()
    if (!serverUrl || !workspaceId || !sessionId) return toast.error('填写远程服务器、工作区和会话 ID 后再添加')
    try { new URL(serverUrl) } catch { return toast.error('远程服务器地址无效') }
    setRemoteMembers(items => [...items, { id: crypto.randomUUID(), serverUrl, workspaceId, sessionId, name: remote.name.trim() || undefined }])
    setRemote({ serverUrl: '', workspaceId: '', sessionId: '', name: '' })
  }
  const save = async () => {
    if (!selected.size && !remoteMembers.length) return toast.error('至少选择或添加一个副会话')
    setSaving(true)
    try {
      const local = sessions.filter(session => selected.has(session.id)).map(session => ({ sessionId: session.id, workspaceId: session.workspaceId, name: getSessionTitle(session) }))
      await window.electronAPI.createCollaboration(primary.id, [...local, ...remoteMembers.map(({ id: _id, ...member }) => member)])
      toast.success(`已启动 ${local.length + remoteMembers.length} 个副会话的协作`); onOpenChange(false)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Unable to create collaboration') } finally { setSaving(false) }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-xl">
    <div className="flex items-center gap-2 pr-8"><Users className="size-5" /><div><h2 className="text-base font-semibold">配置协作</h2><p className="text-sm text-muted-foreground">{getSessionTitle(primary)} 是主会话；可加入同服务器的任意工作区会话，或登记远程服务器会话。</p></div></div>
    <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-foreground/10 p-2">
      {sessions.length === 0 ? <p className="p-3 text-sm text-muted-foreground">没有可用的本地会话。</p> : sessions.map(session => { const checked = selected.has(session.id); return <label key={session.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-foreground/5"><input type="checkbox" checked={checked} onChange={() => setSelected(current => { const next = new Set(current); if (checked) next.delete(session.id); else next.add(session.id); return next })} /><span className="min-w-0"><span className="block truncate text-sm font-medium">{getSessionTitle(session)}</span><span className="block truncate text-xs text-muted-foreground">工作区：{session.workspaceId} · {session.id}</span></span></label> })}
    </div>
    <div className="space-y-2 rounded-md border border-foreground/10 p-3"><div className="flex items-center gap-2 text-sm font-medium"><Globe2 className="size-4" />远程服务器副会话</div><div className="grid gap-2 sm:grid-cols-2"><Input placeholder="wss://server.example" value={remote.serverUrl} onChange={e => setRemote(v => ({ ...v, serverUrl: e.target.value }))} /><Input placeholder="远程工作区 ID" value={remote.workspaceId} onChange={e => setRemote(v => ({ ...v, workspaceId: e.target.value }))} /><Input placeholder="远程会话 ID" value={remote.sessionId} onChange={e => setRemote(v => ({ ...v, sessionId: e.target.value }))} /><Input placeholder="显示名称（可选）" value={remote.name} onChange={e => setRemote(v => ({ ...v, name: e.target.value }))} /></div><Button variant="outline" size="sm" onClick={addRemote}><Plus className="mr-1 size-4" />添加远程会话</Button>{remoteMembers.map(member => <div key={member.id} className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span className="truncate">{member.name ?? member.sessionId} · {member.workspaceId} · {member.serverUrl}</span><button className="text-destructive" onClick={() => setRemoteMembers(items => items.filter(item => item.id !== member.id))}>移除</button></div>)}</div>
    <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button><Button disabled={saving || (!selected.size && !remoteMembers.length)} onClick={() => void save()}>{saving ? '创建中…' : '启动协作'}</Button></div>
  </DialogContent></Dialog>
}

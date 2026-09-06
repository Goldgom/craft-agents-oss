import * as React from 'react'
import { Bot, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import type { CustomAgentDefinition } from '@craft-agent/shared/agents'
import { BuiltinDocHelpButton } from '@/components/ui/BuiltinDocHelpButton'

const EMPTY_AGENT: CustomAgentDefinition = {
  id: '', name: '', description: '', prompt: '', tools: ['Read', 'Grep', 'Glob'],
}

export function AgentManagerPage({ workspaceId, workspaceRootPath }: { workspaceId: string; workspaceRootPath: string }) {
  const [agents, setAgents] = React.useState<CustomAgentDefinition[]>([])
  const [editing, setEditing] = React.useState<CustomAgentDefinition | null>(null)
  const [saving, setSaving] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try { setAgents(await window.electronAPI.listAgents(workspaceId)) }
    catch (error) { toast.error(error instanceof Error ? error.message : '无法加载智能体') }
  }, [workspaceId])

  React.useEffect(() => { void refresh() }, [refresh])

  const save = async () => {
    if (!editing) return
    const candidate = { ...editing, id: editing.id.trim(), name: editing.name.trim(), description: editing.description.trim(), prompt: editing.prompt.trim(), tools: editing.tools?.filter(Boolean) }
    if (!candidate.id || !candidate.name || !candidate.description || !candidate.prompt) return toast.error('请填写 ID、名称、用途说明和指令')
    setSaving(true)
    try {
      await window.electronAPI.saveAgent(workspaceId, candidate)
      toast.success('智能体已保存')
      setEditing(null)
      await refresh()
    } catch (error) { toast.error(error instanceof Error ? error.message : '无法保存智能体') }
    finally { setSaving(false) }
  }

  const updateSession = (patch: NonNullable<CustomAgentDefinition['session']>) => {
    if (!editing) return
    setEditing({ ...editing, session: { ...editing.session, ...patch } })
  }

  const csv = (value: string[] | undefined) => value?.join(', ') ?? ''
  const parseCsv = (value: string) => {
    const values = value.split(',').map(item => item.trim()).filter(Boolean)
    return values.length ? values : undefined
  }

  return <div className="flex h-full flex-col overflow-y-auto px-5 py-5">
      <div className="mb-5">
        <h2 className="flex items-center gap-2 text-base font-semibold"><Bot className="size-4" /> 智能体 <BuiltinDocHelpButton feature="agents" className="ml-auto border-0 px-1.5 py-1 font-normal text-muted-foreground" /></h2>
        <p className="mt-1 text-sm text-muted-foreground">智能体拥有独立的指令和工具权限；主对话可以将边界明确的工作委派给它们。</p>
      </div>
      {editing ? <div className="space-y-4 py-2">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label>标识符</Label><Input value={editing.id} placeholder="code-review" onChange={e => setEditing({ ...editing, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} /></div>
          <div className="space-y-1"><Label>名称</Label><Input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></div>
        </div>
          <div className="space-y-1"><Label>适用场景</Label><Input value={editing.description} onChange={e => setEditing({ ...editing, description: e.target.value })} /></div>
        <div className="space-y-1"><Label>{editing.builtin ? '压缩指令' : '独立指令'}</Label><Textarea className="min-h-36" value={editing.prompt} onChange={e => setEditing({ ...editing, prompt: e.target.value })} /></div>
        {!editing.builtin && <>
          <div className="space-y-1"><Label>工具（以逗号分隔；留空则继承父级工具）</Label><Input value={editing.tools?.join(', ') ?? ''} onChange={e => setEditing({ ...editing, tools: e.target.value.split(',').map(item => item.trim()).filter(Boolean) })} /></div>
          <div className="space-y-1"><Label>模型（可选）</Label><Input value={editing.model ?? ''} placeholder="继承" onChange={e => setEditing({ ...editing, model: e.target.value || undefined })} /></div>
        </>}
        <div className="rounded-lg border border-foreground/10 p-3 space-y-3">
          <div className="text-sm font-medium">专用会话设置</div>
          <p className="text-xs text-muted-foreground">此智能体创建会话时，下列值会覆盖父级和工作区的默认设置。</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label>会话模型</Label><Input value={editing.session?.model ?? ''} placeholder="继承" onChange={e => updateSession({ model: e.target.value || undefined })} /></div>
            <div className="space-y-1"><Label>LLM 连接</Label><Input value={editing.session?.llmConnection ?? ''} placeholder="继承" onChange={e => updateSession({ llmConnection: e.target.value || undefined })} /></div>
          </div>
          <div className="space-y-1"><Label>会话系统提示词（可选）</Label><Textarea className="min-h-24" value={editing.session?.systemPrompt ?? ''} placeholder="默认使用智能体指令" onChange={e => updateSession({ systemPrompt: e.target.value || undefined })} /></div>
          <div className="space-y-1"><Label>启用的数据源（MCP／API／本地，以逗号分隔）</Label><Input value={csv(editing.session?.enabledSourceSlugs)} placeholder="继承工作区数据源" onChange={e => updateSession({ enabledSourceSlugs: parseCsv(e.target.value) })} /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label>MCP 数据源（允许列表）</Label><Input value={csv(editing.session?.mcpSourceSlugs)} placeholder="全部已启用的 MCP" onChange={e => updateSession({ mcpSourceSlugs: parseCsv(e.target.value) })} /></div>
            <div className="space-y-1"><Label>API 数据源（允许列表）</Label><Input value={csv(editing.session?.apiSourceSlugs)} placeholder="全部已启用的 API" onChange={e => updateSession({ apiSourceSlugs: parseCsv(e.target.value) })} /></div>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.session?.showInSessionList ?? !editing.builtin} onChange={e => updateSession({ showInSessionList: e.target.checked })} /> 在会话列表中显示智能体创建的会话</label>
        </div>
      </div> : <div className="space-y-2 py-2">
        {agents.map(agent => <div key={agent.id} className="flex items-start gap-3 rounded-lg border border-foreground/10 p-3">
          <Bot className="mt-0.5 size-4 text-foreground/60" />
          <button type="button" onClick={() => setEditing(agent)} className="min-w-0 flex-1 text-left"><div className="text-sm font-medium">{agent.name}{agent.builtin && <span className="ml-2 text-xs font-normal text-muted-foreground">内置</span>}</div><div className="text-xs text-muted-foreground">{agent.description}</div></button>
          <Button variant="ghost" size="icon" aria-label={agent.builtin ? '重置内置智能体' : '删除智能体'} onClick={async () => { await window.electronAPI.deleteAgent(workspaceId, agent.id); await refresh() }}>{agent.builtin ? <RotateCcw className="size-4" /> : <Trash2 className="size-4" />}</Button>
        </div>)}
      </div>}
      <div className="mt-5 flex gap-2">
        {editing ? <><Button variant="ghost" onClick={() => setEditing(null)}>返回</Button><Button onClick={() => void save()} disabled={saving}>保存智能体</Button></> : <><EditPopover trigger={<Button variant="outline"><Sparkles className="mr-1.5 size-4" />AI 生成</Button>} {...getEditConfig('agent-config', workspaceRootPath)} /><Button onClick={() => setEditing(EMPTY_AGENT)}><Plus className="mr-1.5 size-4" />手动配置</Button></>}
      </div>
  </div>
}

/** @deprecated Use AgentManagerPage for the Automations workspace page. */
export function AgentManagerDialog({ workspaceId, workspaceRootPath, open = false, onOpenChange, showTrigger = true }: { workspaceId: string; workspaceRootPath: string; open?: boolean; onOpenChange?: (open: boolean) => void; showTrigger?: boolean }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    {showTrigger && <button type="button" onClick={() => onOpenChange?.(true)} className="inline-flex items-center gap-1.5 rounded-[8px] border border-foreground/10 px-2.5 py-1.5 text-xs font-medium hover:bg-foreground/[0.04]"><Bot className="size-3.5" /> 智能体</button>}
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"><AgentManagerPage workspaceId={workspaceId} workspaceRootPath={workspaceRootPath} /></DialogContent>
  </Dialog>
}

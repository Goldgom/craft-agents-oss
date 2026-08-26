import * as React from 'react'
import { Bot, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import type { CustomAgentDefinition } from '@craft-agent/shared/agents'
import { BuiltinDocHelpButton } from '@/components/ui/BuiltinDocHelpButton'

const EMPTY_AGENT: CustomAgentDefinition = {
  id: '', name: '', description: '', prompt: '', tools: ['Read', 'Grep', 'Glob'],
}

export function AgentManagerDialog({ workspaceId, workspaceRootPath }: { workspaceId: string; workspaceRootPath: string }) {
  const [open, setOpen] = React.useState(false)
  const [agents, setAgents] = React.useState<CustomAgentDefinition[]>([])
  const [editing, setEditing] = React.useState<CustomAgentDefinition | null>(null)
  const [saving, setSaving] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try { setAgents(await window.electronAPI.listAgents(workspaceId)) }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Unable to load agents') }
  }, [workspaceId])

  React.useEffect(() => { if (open) void refresh() }, [open, refresh])

  const save = async () => {
    if (!editing) return
    const candidate = { ...editing, id: editing.id.trim(), name: editing.name.trim(), description: editing.description.trim(), prompt: editing.prompt.trim(), tools: editing.tools?.filter(Boolean) }
    if (!candidate.id || !candidate.name || !candidate.description || !candidate.prompt) return toast.error('Please complete id, name, description, and instructions')
    setSaving(true)
    try {
      await window.electronAPI.saveAgent(workspaceId, candidate)
      toast.success('Agent saved')
      setEditing(null)
      await refresh()
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Unable to save agent') }
    finally { setSaving(false) }
  }

  return <Dialog open={open} onOpenChange={setOpen}>
    <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-[8px] border border-foreground/10 px-2.5 py-1.5 text-xs font-medium hover:bg-foreground/[0.04]">
      <Bot className="size-3.5" /> Agents
    </button>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Bot className="size-4" /> Agents <BuiltinDocHelpButton feature="agents" className="ml-auto border-0 px-1.5 py-1 font-normal text-muted-foreground" /></DialogTitle>
        <DialogDescription>Agents have independent instructions and tool access. The main conversation can delegate bounded work to them.</DialogDescription>
      </DialogHeader>
      {editing ? <div className="space-y-4 py-2">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label>Id</Label><Input value={editing.id} placeholder="code-review" onChange={e => setEditing({ ...editing, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} /></div>
          <div className="space-y-1"><Label>Name</Label><Input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></div>
        </div>
        <div className="space-y-1"><Label>When to use it</Label><Input value={editing.description} onChange={e => setEditing({ ...editing, description: e.target.value })} /></div>
        <div className="space-y-1"><Label>{editing.builtin ? 'Compaction instructions' : 'Independent instructions'}</Label><Textarea className="min-h-36" value={editing.prompt} onChange={e => setEditing({ ...editing, prompt: e.target.value })} /></div>
        {!editing.builtin && <>
          <div className="space-y-1"><Label>Tools (comma-separated; empty inherits parent tools)</Label><Input value={editing.tools?.join(', ') ?? ''} onChange={e => setEditing({ ...editing, tools: e.target.value.split(',').map(item => item.trim()).filter(Boolean) })} /></div>
          <div className="space-y-1"><Label>Model (optional)</Label><Input value={editing.model ?? ''} placeholder="inherit" onChange={e => setEditing({ ...editing, model: e.target.value || undefined })} /></div>
        </>}
      </div> : <div className="space-y-2 py-2">
        {agents.map(agent => <div key={agent.id} className="flex items-start gap-3 rounded-lg border border-foreground/10 p-3">
          <Bot className="mt-0.5 size-4 text-foreground/60" />
          <button type="button" onClick={() => setEditing(agent)} className="min-w-0 flex-1 text-left"><div className="text-sm font-medium">{agent.name}{agent.builtin && <span className="ml-2 text-xs font-normal text-muted-foreground">Built-in</span>}</div><div className="text-xs text-muted-foreground">{agent.description}</div></button>
          <Button variant="ghost" size="icon" aria-label={agent.builtin ? 'Reset built-in agent' : 'Delete agent'} onClick={async () => { await window.electronAPI.deleteAgent(workspaceId, agent.id); await refresh() }}>{agent.builtin ? <RotateCcw className="size-4" /> : <Trash2 className="size-4" />}</Button>
        </div>)}
      </div>}
      <DialogFooter className="gap-2 sm:justify-between">
        {editing ? <><Button variant="ghost" onClick={() => setEditing(null)}>Back</Button><Button onClick={() => void save()} disabled={saving}>Save agent</Button></> : <><EditPopover trigger={<Button variant="outline"><Sparkles className="mr-1.5 size-4" />AI generate</Button>} {...getEditConfig('agent-config', workspaceRootPath)} /><Button onClick={() => setEditing(EMPTY_AGENT)}><Plus className="mr-1.5 size-4" />Manual configuration</Button></>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

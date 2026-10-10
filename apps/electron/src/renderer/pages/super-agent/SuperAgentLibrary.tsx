import { useState } from 'react'
import { Archive, BrainCircuit, LoaderCircle, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { SuperAgentArchive, SuperAgentCommand, SuperAgentMemory, SuperAgentSnapshot } from '@craft-agent/shared/super-agent'
import { searchSuperAgentLibrary } from '@craft-agent/shared/super-agent'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { WorkbenchSelect } from '@/components/ui/workbench-select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FormField, textareaClass } from './SuperAgentForms'
import { formatTimestamp, useSuperAgentText } from './super-agent-ui'

export function SuperAgentLibrary({ library, snapshot, onCommand }: {
  library: 'archive' | 'memory'; snapshot: SuperAgentSnapshot; onCommand: (command: SuperAgentCommand) => Promise<void>
}) {
  const text = useSuperAgentText()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<SuperAgentMemory | null>(null)
  const [creating, setCreating] = useState(false)
  const [restoring, setRestoring] = useState<SuperAgentArchive | null>(null)
  const [deleting, setDeleting] = useState<SuperAgentMemory | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [category, setCategory] = useState<SuperAgentMemory['category']>('fact')
  const [tags, setTags] = useState('')
  const [evidence, setEvidence] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [versionLabel, setVersionLabel] = useState('')
  const [destination, setDestination] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const memory = library === 'memory'
  const memories = searchSuperAgentLibrary(snapshot.state.memories ?? [], query)
  const archives = searchSuperAgentLibrary(snapshot.state.archives ?? [], query)
  const Icon = memory ? BrainCircuit : Archive
  const categories = [ ['preference', 'memoryPreference'], ['fact', 'memoryFact'], ['decision', 'memoryDecision'], ['lesson', 'memoryLesson'], ['other', 'memoryOther'] ] as const
  function edit(item?: SuperAgentMemory) {
    setEditing(item ?? null); setCreating(true); setTitle(item?.title ?? ''); setContent(item?.content ?? '')
    setCategory(item?.category ?? 'fact'); setTags(item?.tags.join(', ') ?? ''); setEvidence(item?.evidence ?? '')
    setSourcePath(''); setVersionLabel(''); setError(''); setNotice('')
  }
  async function run(command: SuperAgentCommand, after?: () => void) {
    setPending(true); setError(''); setNotice('')
    try { await onCommand(command); after?.() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setPending(false) }
  }
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-3xl space-y-5 p-6">
    <div className="flex items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-lg font-semibold"><Icon className="size-5" />{text(memory ? 'memoryLibrary' : 'archiveLibrary')}</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{text(memory ? 'memoryLibraryHint' : 'archiveLibraryHint')}</p></div>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => edit()}><Plus className="size-3.5" />{text(memory ? 'memoryAdd' : 'archiveAdd')}</Button></div>
    <Input aria-label={text('librarySearch')} placeholder={text('librarySearch')} value={query} onChange={event => setQuery(event.target.value)} />
    {notice && <p role="status" className="rounded-lg bg-primary/10 p-3 text-sm">{notice}</p>}
    {!creating && !restoring && !deleting && error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!(memory ? memories : archives).length && <p className="py-8 text-center text-sm text-muted-foreground">{text(memory ? 'memoryEmpty' : 'archiveEmpty')}</p>}
    {memory ? memories.map(item => <section key={item.id} className="space-y-3 rounded-xl border border-border/70 p-5">
      <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{item.title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{text(categories.find(([value]) => value === item.category)![1])} · {formatTimestamp(item.updatedAt)} · v{item.revision}</p></div>
        <Button size="icon" variant="ghost" aria-label={text('edit')} disabled={pending} onClick={() => edit(item)}><Pencil className="size-4" /></Button>
        <Button size="icon" variant="ghost" aria-label={text('delete')} disabled={pending} onClick={() => { setDeleting(item); setError('') }}><Trash2 className="size-4" /></Button></div>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{item.content}</p>
      {item.evidence && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{text('memoryEvidence')}: {item.evidence}</p>}
      <p className="break-all text-xs text-muted-foreground">{item.tags.join(' · ')}{item.tags.length ? ' · ' : ''}{item.id}</p>
    </section>) : archives.map(item => <section key={item.id} className="space-y-3 rounded-xl border border-border/70 p-5">
      <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{item.title}{item.versionLabel && ` · ${item.versionLabel}`}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{formatTimestamp(item.createdAt)} · {item.files.length} {text('archiveFiles')} · {(item.files.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(2)} MB</p></div>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => { setRestoring(item); setDestination(''); setError(''); setNotice('') }}><RotateCcw className="size-3.5" />{text('archiveRestore')}</Button></div>
      {item.description && <p className="whitespace-pre-wrap text-sm leading-6">{item.description}</p>}
      <p className="break-all font-mono text-xs text-muted-foreground">{item.sourcePath}</p>
      <p className="break-all text-xs text-muted-foreground">{item.tags.join(' · ')}{item.tags.length ? ' · ' : ''}{item.id}</p>
      <details><summary className="cursor-pointer text-xs text-muted-foreground">{text('archiveFiles')} ({item.files.length})</summary><div className="mt-2 max-h-64 overflow-auto space-y-2">
        {item.files.map(file => <p key={file.path} className="break-all font-mono text-[11px]">{file.path} · {file.size} B<br /><span className="text-muted-foreground">SHA-256: {file.sha256}</span></p>)}</div></details>
    </section>)}
    <Dialog open={creating} onOpenChange={open => { if (!pending) setCreating(open) }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>{text(memory ? 'memoryLibrary' : 'archiveAdd')}</DialogTitle><DialogDescription>{text(memory ? 'memoryLibraryHint' : 'archiveSourceHint')}</DialogDescription></DialogHeader>
      <fieldset disabled={pending} className="space-y-4">
        <FormField label={text('name')}><Input maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></FormField>
        {memory ? <>
          <FormField label={text('memoryCategory')}><WorkbenchSelect value={category} onValueChange={value => setCategory(value as SuperAgentMemory['category'])} options={categories.map(([value, key]) => ({ value, label: text(key) }))} /></FormField>
          <FormField label={text('content')}><textarea rows={7} maxLength={32000} className={textareaClass} value={content} onChange={event => setContent(event.target.value)} /></FormField>
          <FormField label={text('memoryEvidence')}><textarea rows={2} maxLength={4000} className={textareaClass} value={evidence} onChange={event => setEvidence(event.target.value)} /></FormField>
        </> : <>
          <FormField label={text('archiveSource')}><Input maxLength={4096} value={sourcePath} onChange={event => setSourcePath(event.target.value)} placeholder="project/src" /></FormField>
          <FormField label={text('archiveVersion')}><Input maxLength={120} value={versionLabel} onChange={event => setVersionLabel(event.target.value)} /></FormField>
          <FormField label={text('description')}><textarea rows={3} maxLength={4000} className={textareaClass} value={content} onChange={event => setContent(event.target.value)} /></FormField>
        </>}
        <FormField label={text('libraryTags')}><Input value={tags} maxLength={1296} onChange={event => setTags(event.target.value)} /></FormField>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={() => setCreating(false)}>{text('cancel')}</Button><Button disabled={!title.trim() || (memory ? !content.trim() : !sourcePath.trim())} onClick={() => {
          const values = [...new Set(tags.split(/[,，]/).map(value => value.trim()).filter(Boolean))]
          void run(memory ? { type: 'memory-upsert', item: { id: editing?.id, title, content, category, tags: values, evidence }, expectedRevision: editing?.revision ?? 0 }
            : { type: 'archive-create', item: { title, sourcePath, versionLabel, description: content, tags: values } }, () => setCreating(false))
        }}>{pending && <LoaderCircle className="size-3.5 animate-spin" />}{text(memory ? 'save' : 'archiveAdd')}</Button></DialogFooter>
      </fieldset>
    </DialogContent></Dialog>
    <Dialog open={restoring !== null} onOpenChange={open => { if (!open && !pending) setRestoring(null) }}><DialogContent><DialogHeader><DialogTitle>{text('archiveRestore')}</DialogTitle><DialogDescription>{text('archiveRestoreHint')}</DialogDescription></DialogHeader>
      <FormField label={text('archiveDestination')}><Input disabled={pending} value={destination} maxLength={4096} onChange={event => setDestination(event.target.value)} placeholder="restored-v1" /></FormField>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setRestoring(null)}>{text('cancel')}</Button><Button disabled={pending || !destination.trim()} onClick={() => restoring && void run({ type: 'archive-restore', id: restoring.id, destination }, () => { setRestoring(null); setNotice(`${text('archiveRestored')}: ${destination}`) })}>{pending && <LoaderCircle className="size-3.5 animate-spin" />}{text('archiveRestore')}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={deleting !== null} onOpenChange={open => { if (!open && !pending) setDeleting(null) }}><DialogContent><DialogHeader><DialogTitle>{text('delete')}</DialogTitle><DialogDescription>{text('memoryDeleteHint')}</DialogDescription></DialogHeader>
      <p className="text-sm">{deleting?.title}</p>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setDeleting(null)}>{text('cancel')}</Button><Button variant="destructive" disabled={pending} onClick={() => deleting && void run({ type: 'memory-delete', id: deleting.id, expectedRevision: deleting.revision }, () => setDeleting(null))}>{text('delete')}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div></div>
}

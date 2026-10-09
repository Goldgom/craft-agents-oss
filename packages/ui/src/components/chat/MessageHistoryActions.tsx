import { useRef, useState, type ReactNode } from 'react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { Copy, Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { usePlatform } from '../../context/PlatformContext'

const itemClass = 'flex items-center gap-2 rounded px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-foreground/5 data-[disabled]:opacity-50'

/** Capture selection before the context menu takes focus. */
export function messageCopyText(root: HTMLElement, selection: Selection | null, fallback: string): string {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return fallback
  const range = selection.getRangeAt(0)
  return range.intersectsNode(root) ? selection.toString() || fallback : fallback
}

export function MessageHistoryActions({ content, children, onEdit, editDisabled, branchCount = 0, branches, onSelectBranch }: {
  content: string
  children: ReactNode
  onEdit?: (content: string) => Promise<void>
  editDisabled?: boolean
  branchCount?: number
  branches?: Array<{ id: string; name?: string }>
  onSelectBranch?: (id: string) => void
}) {
  const { t } = useTranslation()
  const { onCopyToClipboard } = usePlatform()
  const rootRef = useRef<HTMLDivElement>(null)
  const copyRef = useRef(content)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(content)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const cannotEdit = editDisabled || branchCount >= 10
  const beginEdit = () => { setDraft(content); setError(undefined); setEditing(true) }
  const save = async () => {
    if (!onEdit || saving || cannotEdit || !draft.trim() || draft === content) return
    setSaving(true)
    setError(undefined)
    try { await onEdit(draft); setEditing(false) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setSaving(false) }
  }
  const copy = async () => {
    try {
      if (onCopyToClipboard) await onCopyToClipboard(copyRef.current)
      else await navigator.clipboard.writeText(copyRef.current)
    } catch { setError(t('chat.history.copyFailed')) }
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild disabled={editing}>
        <div ref={rootRef} className="group/history min-w-0" onContextMenuCapture={() => {
          if (rootRef.current) copyRef.current = messageCopyText(rootRef.current, window.getSelection(), content)
        }}>
          {editing ? (
            <div className="rounded-lg border border-border bg-background p-3 space-y-2">
              <textarea autoFocus aria-label={t('chat.history.edit')} value={draft} disabled={saving}
                onChange={event => setDraft(event.target.value)} rows={Math.min(16, Math.max(4, draft.split('\n').length))}
                className="w-full resize-y bg-transparent text-sm outline-none select-text"
                onKeyDown={event => {
                  if (event.key === 'Escape' && !saving) { event.preventDefault(); setEditing(false) }
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() }
                }} />
              <p className="text-xs text-muted-foreground">{t('chat.history.editHint')}</p>
              <div className="flex justify-end gap-2">
                <button type="button" disabled={saving} className="px-3 py-1.5 text-sm rounded hover:bg-foreground/5 disabled:opacity-50" onClick={() => setEditing(false)}>{t('common.cancel')}</button>
                <button type="button" disabled={saving || cannotEdit || !draft.trim() || draft === content}
                  className="px-3 py-1.5 text-sm rounded bg-foreground text-background disabled:opacity-50" onClick={() => { void save() }}>
                  {t(saving ? 'chat.history.creating' : 'chat.history.saveBranch')}
                </button>
              </div>
            </div>
          ) : <>
            {children}
            {!!branches?.length && <div className="flex flex-wrap justify-end gap-1 mt-1" aria-label={t('chat.history.branches')}>
              {branches.map((branch, index) => <button type="button" key={branch.id} title={branch.name}
                onClick={() => onSelectBranch?.(branch.id)} className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-foreground/5">
                {t('chat.history.branchNumber', { number: index + 1 })}
              </button>)}
            </div>}
            {onEdit && <div className="flex justify-end mt-1">
              <button type="button" disabled={cannotEdit} onClick={beginEdit}
                title={t(branchCount >= 10 ? 'chat.history.branchLimit' : 'chat.history.edit')}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground opacity-0 group-hover/history:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-foreground/5 disabled:opacity-40">
                <Pencil className="size-3" />{t('chat.history.edit')}
              </button>
            </div>}
          </>}
          {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="popover-styled z-dropdown min-w-40 p-1" onCloseAutoFocus={event => event.preventDefault()}>
          <ContextMenu.Item className={itemClass} onSelect={() => { void copy() }}><Copy className="size-3.5" />{t('common.copy')}</ContextMenu.Item>
          {onEdit && <ContextMenu.Item className={itemClass} disabled={cannotEdit} onSelect={beginEdit}><Pencil className="size-3.5" />{t('chat.history.edit')}</ContextMenu.Item>}
          {branchCount >= 10 && <div className="px-2 py-1 text-xs text-muted-foreground">{t('chat.history.branchLimit')}</div>}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

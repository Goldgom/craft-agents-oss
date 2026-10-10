import { useRef, useState, type ReactNode } from 'react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { ChevronLeft, ChevronRight, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { usePlatform } from '../../context/PlatformContext'

const itemClass = 'flex items-center gap-2 rounded px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-foreground/5 data-[disabled]:opacity-50'

/** Capture selection before the context menu takes focus. */
export function messageCopyText(root: HTMLElement, selection: Selection | null, fallback: string): string {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return fallback
  const range = selection.getRangeAt(0)
  return range.intersectsNode(root) ? selection.toString() || fallback : fallback
}

export function MessageHistoryActions({ content, children, onEdit, editDisabled, branchCount = 0, branches, currentSessionId, onSelectBranch }: {
  content: string
  children: ReactNode
  onEdit?: (content: string) => Promise<void>
  editDisabled?: boolean
  branchCount?: number
  branches?: Array<{ id: string; name?: string }>
  currentSessionId?: string
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
  const branchIndex = Math.max(0, branches?.findIndex(branch => branch.id === currentSessionId) ?? 0)
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
        <div ref={rootRef} className="group/history min-w-0" onDoubleClick={event => {
          const target = event.target as HTMLElement
          if (editing || !onEdit || cannotEdit || target.closest('button, a, input, textarea, [role="button"], [contenteditable="true"]')) return
          if (!target.closest('[data-theme-bubble="user"], [data-theme-bubble="assistant"]')) return
          event.preventDefault()
          event.stopPropagation()
          window.getSelection()?.removeAllRanges()
          beginEdit()
        }} onContextMenuCapture={() => {
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
            {branches && branches.length > 1 && <div className="flex justify-end mt-1" aria-label={t('chat.history.branches')}>
              <div className="inline-flex items-center gap-1 text-sm text-muted-foreground tabular-nums">
                <button type="button" aria-label={t('overlay.previousItem')}
                  title={branches[branchIndex - 1]?.name} disabled={!onSelectBranch || branchIndex === 0}
                  onClick={() => onSelectBranch?.(branches[branchIndex - 1]!.id)}
                  className="flex size-7 items-center justify-center rounded-full hover:bg-foreground/5 disabled:opacity-30 disabled:pointer-events-none">
                  <ChevronLeft className="size-4" />
                </button>
                <span aria-live="polite"><span className="text-foreground">{branchIndex + 1}</span><span className="px-1">/</span>{branches.length}</span>
                <button type="button" aria-label={t('overlay.nextItem')}
                  title={branches[branchIndex + 1]?.name} disabled={!onSelectBranch || branchIndex === branches.length - 1}
                  onClick={() => onSelectBranch?.(branches[branchIndex + 1]!.id)}
                  className="flex size-7 items-center justify-center rounded-full hover:bg-foreground/5 disabled:opacity-30 disabled:pointer-events-none">
                  <ChevronRight className="size-4" />
                </button>
              </div>
            </div>}
          </>}
          {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="popover-styled z-dropdown min-w-40 p-1" onCloseAutoFocus={event => event.preventDefault()}>
          <ContextMenu.Item className={itemClass} onSelect={() => { void copy() }}><Copy className="size-3.5" />{t('common.copy')}</ContextMenu.Item>
          {branchCount >= 10 && <div className="px-2 py-1 text-xs text-muted-foreground">{t('chat.history.branchLimit')}</div>}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

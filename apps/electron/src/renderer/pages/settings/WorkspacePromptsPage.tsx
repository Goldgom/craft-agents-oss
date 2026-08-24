/**
 * WorkspacePromptsPage — 全局提示词设置
 *
 * Manage workspace-wide preference prompts:
 * - Manually create/edit prompts (title + content)
 * - AI-generate prompts from a short description
 * - Toggle each prompt on/off independently; enabled prompts are injected
 *   into every conversation in this workspace.
 */

import * as React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListTree, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Button } from '@/components/ui/button'
import { Spinner } from '@craft-agent/ui'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import {
  SettingsSection,
  SettingsCard,
  SettingsToggle,
  SettingsInput,
  SettingsTextarea,
} from '@/components/settings'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { WorkspacePrompt } from '../../../shared/types'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'prompts',
}

interface GeneratedPrompt {
  title: string
  content: string
}

export default function WorkspacePromptsPage() {
  const { t } = useTranslation()
  const appShellContext = useAppShellContext()
  const activeWorkspaceId = appShellContext.activeWorkspaceId

  const [prompts, setPrompts] = useState<WorkspacePrompt[]>([])
  const [loading, setLoading] = useState(true)

  // Manual editor state
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<WorkspacePrompt | null>(null)
  const [editorTitle, setEditorTitle] = useState('')
  const [editorContent, setEditorContent] = useState('')
  const [saving, setSaving] = useState(false)

  // AI generation state
  const [generateOpen, setGenerateOpen] = useState(false)
  const [description, setDescription] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generated, setGenerated] = useState<GeneratedPrompt | null>(null)
  const [applying, setApplying] = useState(false)

  const loadPrompts = React.useCallback(async () => {
    if (!window.electronAPI || !activeWorkspaceId) {
      setLoading(false)
      return
    }
    try {
      const list = await window.electronAPI.getWorkspacePrompts(activeWorkspaceId)
      setPrompts(list)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.prompts.errors.load'))
    } finally {
      setLoading(false)
    }
  }, [activeWorkspaceId, t])

  useEffect(() => {
    void loadPrompts()
  }, [loadPrompts])

  const openEditor = (prompt: WorkspacePrompt | null) => {
    setEditing(prompt)
    setEditorTitle(prompt?.title ?? '')
    setEditorContent(prompt?.content ?? '')
    setEditorOpen(true)
  }

  const handleSave = async () => {
    if (!activeWorkspaceId) return
    const title = editorTitle.trim()
    const content = editorContent.trim()
    if (!title || !content) return
    setSaving(true)
    try {
      const saved = await window.electronAPI.saveWorkspacePrompt(activeWorkspaceId, {
        id: editing?.id,
        title,
        content,
        enabled: editing?.enabled ?? true,
        source: editing?.source ?? 'manual',
      })
      setPrompts(prev => {
        const next = prev.filter(p => p.id !== saved.id)
        return [...next, saved]
      })
      toast.success(t('settings.prompts.toasts.saved'))
      setEditorOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.prompts.errors.save'))
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (prompt: WorkspacePrompt, enabled: boolean) => {
    if (!activeWorkspaceId) return
    // Optimistic update
    setPrompts(prev => prev.map(p => (p.id === prompt.id ? { ...p, enabled } : p)))
    try {
      await window.electronAPI.saveWorkspacePrompt(activeWorkspaceId, { ...prompt, enabled })
    } catch (err) {
      // Roll back on failure
      setPrompts(prev => prev.map(p => (p.id === prompt.id ? { ...p, enabled: !enabled } : p)))
      toast.error(err instanceof Error ? err.message : t('settings.prompts.errors.save'))
    }
  }

  const handleDelete = async (prompt: WorkspacePrompt) => {
    if (!activeWorkspaceId) return
    try {
      await window.electronAPI.deleteWorkspacePrompt(activeWorkspaceId, prompt.id)
      setPrompts(prev => prev.filter(p => p.id !== prompt.id))
      toast.success(t('settings.prompts.toasts.deleted'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.prompts.errors.delete'))
    }
  }

  const openGenerator = () => {
    setDescription('')
    setGenerated(null)
    setGenerateOpen(true)
  }

  const handleGenerate = async () => {
    if (!activeWorkspaceId || !description.trim()) return
    setGenerating(true)
    setGenerated(null)
    try {
      const result = await window.electronAPI.generateWorkspacePrompt(activeWorkspaceId, description.trim())
      setGenerated(result)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.prompts.errors.generate'))
    } finally {
      setGenerating(false)
    }
  }

  const handleApplyGenerated = async () => {
    if (!activeWorkspaceId || !generated) return
    setApplying(true)
    try {
      const saved = await window.electronAPI.saveWorkspacePrompt(activeWorkspaceId, {
        title: generated.title,
        content: generated.content,
        source: 'ai',
      })
      setPrompts(prev => [...prev, saved])
      toast.success(t('settings.prompts.toasts.applied'))
      setGenerateOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.prompts.errors.save'))
    } finally {
      setApplying(false)
    }
  }

  const sortedPrompts = [...prompts].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t('settings.prompts.title')}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate(routes.view.settings('promptOverview'))}>
              <ListTree className="h-3.5 w-3.5 mr-1.5" />
              {t('settings.prompts.totalPrompt')}
            </Button>
            <Button variant="outline" size="sm" onClick={openGenerator}>
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              {t('settings.prompts.aiGenerate')}
            </Button>
            <Button variant="default" size="sm" onClick={() => openEditor(null)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              {t('settings.prompts.add')}
            </Button>
            <HeaderMenu route={routes.view.settings('prompts')} helpFeature="workspaces" />
          </div>
        }
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto space-y-8">
            <SettingsSection
              title={t('settings.prompts.sectionTitle')}
              description={t('settings.prompts.sectionDesc')}
            >
              <SettingsCard divided>
                {loading ? (
                  <div className="flex items-center justify-center py-10">
                    <Spinner />
                  </div>
                ) : sortedPrompts.length === 0 ? (
                  <div className="px-4 py-10 text-center space-y-2">
                    <p className="text-sm text-foreground/70">{t('settings.prompts.empty')}</p>
                    <p className="text-xs text-foreground/50">{t('settings.prompts.emptyHint')}</p>
                  </div>
                ) : (
                  sortedPrompts.map(prompt => (
                    <div key={prompt.id} className="px-4 py-3 space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">{prompt.title}</span>
                            <span
                              className={cn(
                                'text-[10px] px-1.5 py-0.5 rounded-full border shrink-0',
                                prompt.source === 'ai'
                                  ? 'border-purple-400/40 text-purple-400/90'
                                  : 'border-foreground/20 text-foreground/60',
                              )}
                            >
                              {prompt.source === 'ai' ? t('settings.prompts.ai') : t('settings.prompts.manual')}
                            </span>
                          </div>
                          <p className="text-xs text-foreground/60 line-clamp-2 mt-1 whitespace-pre-wrap">
                            {prompt.content}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('settings.prompts.edit')}
                            title={t('settings.prompts.edit')}
                            onClick={() => openEditor(prompt)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('settings.prompts.delete')}
                            title={t('settings.prompts.delete')}
                            onClick={() => void handleDelete(prompt)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      <SettingsToggle
                        label={t('settings.prompts.enabled')}
                        description={t('settings.prompts.enabledDesc')}
                        checked={prompt.enabled}
                        onCheckedChange={checked => void handleToggle(prompt, checked)}
                        inCard
                      />
                    </div>
                  ))
                )}
              </SettingsCard>
            </SettingsSection>
          </div>
        </ScrollArea>
      </div>

      {/* Manual editor dialog */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? t('settings.prompts.editorTitleEdit') : t('settings.prompts.editorTitleNew')}
            </DialogTitle>
            <DialogDescription>{t('settings.prompts.editorDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <SettingsInput
              label={t('settings.prompts.titleLabel')}
              value={editorTitle}
              onChange={setEditorTitle}
              placeholder={t('settings.prompts.titlePlaceholder')}
              inCard
            />
            <SettingsTextarea
              label={t('settings.prompts.contentLabel')}
              value={editorContent}
              onChange={setEditorContent}
              placeholder={t('settings.prompts.contentPlaceholder')}
              rows={6}
              inCard
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditorOpen(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => void handleSave()}
              disabled={saving || !editorTitle.trim() || !editorContent.trim()}
            >
              {saving ? <Spinner className="h-4 w-4" /> : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI generation dialog */}
      <Dialog open={generateOpen} onOpenChange={setGenerateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.prompts.generateTitle')}</DialogTitle>
            <DialogDescription>{t('settings.prompts.generateDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <SettingsTextarea
              label={t('settings.prompts.descriptionLabel')}
              value={description}
              onChange={setDescription}
              placeholder={t('settings.prompts.descriptionPlaceholder')}
              rows={4}
              inCard
            />
            {generated && (
              <div className="rounded-lg border border-foreground/10 bg-foreground/[0.03] p-3 space-y-2">
                <p className="text-xs font-medium text-foreground/70">{t('settings.prompts.resultPreview')}</p>
                <p className="text-sm font-medium">{generated.title}</p>
                <p className="text-xs text-foreground/70 whitespace-pre-wrap max-h-40 overflow-y-auto">
                  {generated.content}
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setGenerateOpen(false)} disabled={generating || applying}>
              {t('common.cancel')}
            </Button>
            {generated ? (
              <Button onClick={() => void handleApplyGenerated()} disabled={applying}>
                {applying ? <Spinner className="h-4 w-4" /> : t('settings.prompts.apply')}
              </Button>
            ) : (
              <Button onClick={() => void handleGenerate()} disabled={generating || !description.trim()}>
                {generating ? <Spinner className="h-4 w-4" /> : t('settings.prompts.generate')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

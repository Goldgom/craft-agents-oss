/**
 * AppearanceSettingsPage
 *
 * Visual customization settings: theme mode, color theme, font,
 * workspace-specific theme overrides, and CLI tool icon mappings.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { ColumnDef } from '@tanstack/react-table'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { EditPopover, EditButton, getEditConfig } from '@/components/ui/EditPopover'
import { useTheme } from '@/context/ThemeContext'
import { useAppShellContext } from '@/context/AppShellContext'
import { routes } from '@/lib/navigate'
import { Monitor, Sun, Moon, FolderOpen, PackagePlus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { ToolIconMapping } from '../../../shared/types'
import type { ThemePack } from '@config/theme-pack'

import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsMenuSelect,
  SettingsToggle,
} from '@/components/settings'
import { useAtom } from 'jotai'
import * as storage from '@/lib/local-storage'
import { useWorkspaceIcons } from '@/hooks/useWorkspaceIcon'
import { WorkspaceAvatar } from '@/components/ui/workspace-avatar'
import { ColorPicker } from '@/components/ui/color-picker'
import { workspaceAvatarColorsAtom } from '@/atoms/workspace-avatar-colors'
import { kanbanColumnColorsAtom, kanbanColumnStatusAtom, kanbanLivePulseAtom } from '@/atoms/kanban'
import { showBackgroundFinishedChipAtom } from '@/atoms/background-finished'
import { modelGroupExpansionAtom } from '@/atoms/model-picker'
import { KANBAN_COLUMNS } from '@/components/app-shell/kanban/status-column'
import { DEFAULT_KANBAN_COLUMN_COLORS } from '@/components/app-shell/kanban/kanban-colors'
import type { KanbanColumnId } from '@/components/app-shell/kanban/types'
import { setProjectColorTreatment, useProjectColorTreatment } from '@/hooks/useProjectColorTreatment'
import { PROJECT_COLOR_PALETTE, type ProjectColorTreatment } from '@/utils/project-colors'
import { Info_DataTable, SortableHeader } from '@/components/info/Info_DataTable'
import { Info_Badge } from '@/components/info/Info_Badge'
import type { PresetTheme } from '@config/theme'
import { BirdCompanionSettings } from '@/components/settings/BirdCompanionSettings'
import { ThemePresetGallery } from '@/components/settings/ThemePresetGallery'
import { ThemePresentationSettings } from '@/components/settings/ThemePresentationSettings'
import { CatalogPagination } from './CatalogPagination'

const THEME_PACK_PAGE_SIZE = 6

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'appearance',
}

// ============================================
// Tool Icons Table
// ============================================

/**
 * Column definitions for the tool icon mappings table.
 * Shows a preview icon, tool name, and the CLI commands that trigger it.
 */
const getToolIconColumns = (t: (key: string) => string): ColumnDef<ToolIconMapping>[] => [
  {
    accessorKey: 'iconDataUrl',
    header: () => <span className="p-1.5 pl-2.5">{t("settings.appearance.iconHeader")}</span>,
    cell: ({ row }) => (
      <div className="p-1.5 pl-2.5">
        <img
          src={row.original.iconDataUrl}
          alt={row.original.displayName}
          className="w-5 h-5 object-contain"
        />
      </div>
    ),
    size: 60,
    enableSorting: false,
  },
  {
    accessorKey: 'displayName',
    header: ({ column }) => <SortableHeader column={column} title={t("settings.appearance.toolHeader")} />,
    cell: ({ row }) => (
      <div className="p-1.5 pl-2.5 font-medium">
        {row.original.displayName}
      </div>
    ),
    size: 150,
  },
  {
    accessorKey: 'commands',
    header: () => <span className="p-1.5 pl-2.5">{t("settings.appearance.commandsHeader")}</span>,
    cell: ({ row }) => (
      <div className="p-1.5 pl-2.5 flex flex-wrap gap-1">
        {row.original.commands.map(cmd => (
          <Info_Badge key={cmd} color="muted" className="font-mono">
            {cmd}
          </Info_Badge>
        ))}
      </div>
    ),
    meta: { fillWidth: true },
    enableSorting: false,
  },
]

// ============================================
// Main Component
// ============================================

export default function AppearanceSettingsPage() {
  const { t } = useTranslation()
  const [modelGroupExpansion, setModelGroupExpansion] = useAtom(modelGroupExpansionAtom)
  const toolIconColumns = useMemo(() => getToolIconColumns(t), [t])

  const {
    mode,
    isDark,
    setMode,
    colorTheme,
    setColorTheme,
    font,
    setFont,
    chatOpacity,
    setChatOpacity,
    chatPanelOpacity,
    setChatPanelOpacity,
    activeWorkspaceId,
    setWorkspaceColorTheme,
    themeLoadError,
    themeResolvedFrom,
    themePacks,
    themePackId,
    activeThemePack,
    setThemePack,
    importThemePack,
    deleteThemePack,
    themePackScriptsEnabled,
    setThemePackScriptsEnabled,
  } = useTheme()
  const { workspaces, sessionStatuses } = useAppShellContext()

  // Fetch workspace icons as data URLs (file:// URLs don't work in renderer)
  const workspaceIconMap = useWorkspaceIcons(workspaces)

  // Preset themes for the color theme dropdown
  const [presetThemes, setPresetThemes] = useState<PresetTheme[]>([])

  const [themePackPage, setThemePackPage] = useState(1)
  const themePackPageCount = Math.max(1, Math.ceil(themePacks.length / THEME_PACK_PAGE_SIZE))
  const currentThemePackPage = Math.min(themePackPage, themePackPageCount)
  const visibleThemePacks = themePacks.slice(
    (currentThemePackPage - 1) * THEME_PACK_PAGE_SIZE,
    currentThemePackPage * THEME_PACK_PAGE_SIZE,
  )

  // Keep the current page valid when deleting packs from the last page.
  useEffect(() => {
    setThemePackPage(page => Math.min(page, themePackPageCount))
  }, [themePackPageCount])

  // Match preview artwork to the current appearance and load packs in parallel.
  const [packPreviews, setPackPreviews] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    const loadPreviews = async () => {
      const previews: Record<string, string> = {}
      await Promise.all(themePacks.map(async (pack) => {
        const ref = isDark ? pack.manifest.preview?.dark ?? pack.manifest.preview?.light : pack.manifest.preview?.light ?? pack.manifest.preview?.dark
        if (!ref) return
        try {
          const asset = await window.electronAPI?.getThemePackAsset?.(pack.id, ref)
          if (asset?.dataUrl) previews[pack.id] = asset.dataUrl
        } catch { /* an unavailable preview should not hide the pack list */ }
      }))
      if (!cancelled) setPackPreviews(previews)
    }
    void loadPreviews()
    return () => { cancelled = true }
  }, [themePacks, isDark])

  const [importingPack, setImportingPack] = useState(false)
  const handleImportPack = useCallback(async (format: 'zip' | 'folder' = 'zip') => {
    setImportingPack(true)
    try {
      await importThemePack(format)
    } catch (error) {
      toast.error(t('settings.appearance.themePackImportFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setImportingPack(false)
    }
  }, [importThemePack, t])

  const handleOpenPacksFolder = useCallback(async () => {
    const dir = await window.electronAPI?.getThemePacksDir?.()
    if (dir) window.electronAPI?.showInFolder?.(dir)
  }, [])

  // Per-workspace theme overrides (workspaceId -> themeId or undefined)
  const [workspaceThemes, setWorkspaceThemes] = useState<Record<string, string | undefined>>({})

  // Tool icon mappings loaded from main process
  const [toolIcons, setToolIcons] = useState<ToolIconMapping[]>([])

  // Resolved path to tool-icons.json (needed for EditPopover and "Edit File" action)
  const [toolIconsJsonPath, setToolIconsJsonPath] = useState<string | null>(null)

  // Connection icon visibility toggle
  const [showConnectionIcons, setShowConnectionIcons] = useState(() =>
    storage.get(storage.KEYS.showConnectionIcons, true)
  )
  const handleConnectionIconsChange = useCallback((checked: boolean) => {
    setShowConnectionIcons(checked)
    storage.set(storage.KEYS.showConnectionIcons, checked)
  }, [])

  // Project color treatment in the SessionList
  const projectColorTreatment = useProjectColorTreatment()
  const handleProjectColorTreatmentChange = useCallback((value: string) => {
    setProjectColorTreatment(value as ProjectColorTreatment)
  }, [])

  // Per-workspace avatar color overrides (persisted in localStorage)
  const [workspaceAvatarColors, setWorkspaceAvatarColors] = useAtom(workspaceAvatarColorsAtom)
  const setWorkspaceAvatarColor = useCallback((workspaceId: string, hex: string) => {
    setWorkspaceAvatarColors(prev => ({ ...prev, [workspaceId]: hex }))
  }, [setWorkspaceAvatarColors])
  const clearWorkspaceAvatarColor = useCallback((workspaceId: string) => {
    setWorkspaceAvatarColors(prev => {
      const next = { ...prev }
      delete next[workspaceId]
      return next
    })
  }, [setWorkspaceAvatarColors])

  // Kanban board appearance (persisted in localStorage via atomWithStorage).
  const [kanbanColumnColors, setKanbanColumnColors] = useAtom(kanbanColumnColorsAtom)
  const setKanbanColumnColor = useCallback((column: KanbanColumnId, hex: string) => {
    setKanbanColumnColors(prev => ({ ...prev, [column]: hex }))
  }, [setKanbanColumnColors])
  const resetKanbanColumnColor = useCallback((column: KanbanColumnId) => {
    setKanbanColumnColors(prev => {
      const next = { ...prev }
      delete next[column]
      return next
    })
  }, [setKanbanColumnColors])
  const [kanbanLivePulse, setKanbanLivePulse] = useAtom(kanbanLivePulseAtom)

  // Per-column status applied when a task is dragged into that column. Empty
  // selection ('') removes the mapping → status left unchanged on move.
  const [kanbanColumnStatus, setKanbanColumnStatus] = useAtom(kanbanColumnStatusAtom)
  const setColumnStatus = useCallback((column: KanbanColumnId, statusId: string) => {
    setKanbanColumnStatus(prev => {
      const next = { ...prev }
      if (statusId) next[column] = statusId
      else delete next[column]
      return next
    })
  }, [setKanbanColumnStatus])
  const columnStatusOptions = useMemo(
    () => [
      { value: '', label: t("settings.appearance.kanbanColumnStatusNone") },
      ...(sessionStatuses ?? []).map(s => ({ value: s.id, label: s.label })),
    ],
    [sessionStatuses, t]
  )

  // "Background session finished" chip toggle (renderer-only appearance pref,
  // persisted in localStorage via atomWithStorage — read by App.tsx + ChatPage).
  const [showBackgroundFinishedChip, setShowBackgroundFinishedChip] = useAtom(showBackgroundFinishedChipAtom)

  // Load preset themes on mount
  useEffect(() => {
    const loadThemes = async () => {
      if (!window.electronAPI) {
        setPresetThemes([])
        return
      }
      try {
        const themes = await window.electronAPI.loadPresetThemes()
        setPresetThemes(themes)
      } catch (error) {
        console.error('Failed to load preset themes:', error)
        setPresetThemes([])
      }
    }
    loadThemes()
  }, [])

  // Load workspace themes on mount
  useEffect(() => {
    const loadWorkspaceThemes = async () => {
      if (!window.electronAPI?.getAllWorkspaceThemes) return
      try {
        const themes = await window.electronAPI.getAllWorkspaceThemes()
        setWorkspaceThemes(themes)
      } catch (error) {
        console.error('Failed to load workspace themes:', error)
      }
    }
    loadWorkspaceThemes()
  }, [])

  // Load tool icon mappings and resolve the config file path on mount
  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      try {
        const [mappings, homeDir] = await Promise.all([
          window.electronAPI.getToolIconMappings(),
          window.electronAPI.getHomeDir(),
        ])
        setToolIcons(mappings)
        setToolIconsJsonPath(`${homeDir}/.tokenbird/tool-icons/tool-icons.json`)
      } catch (error) {
        console.error('Failed to load tool icon mappings:', error)
      }
    }
    load()
  }, [])

  // Handler for workspace theme change
  // Uses ThemeContext for the active workspace (immediate visual update) and IPC for other workspaces
  const handleWorkspaceThemeChange = useCallback(
    async (workspaceId: string, value: string) => {
      // 'default' means inherit from app default (null in storage)
      const themeId = value === 'default' ? null : value

      // If changing the current workspace, use context for immediate update
      if (workspaceId === activeWorkspaceId) {
        setWorkspaceColorTheme(themeId)
      } else {
        // For other workspaces, just persist via IPC
        await window.electronAPI?.setWorkspaceColorTheme?.(workspaceId, themeId)
      }

      // Update local state for UI
      setWorkspaceThemes(prev => ({
        ...prev,
        [workspaceId]: themeId ?? undefined
      }))
    },
    [activeWorkspaceId, setWorkspaceColorTheme]
  )

  // Theme options for dropdowns
  const themeOptions = useMemo(() => [
    { value: 'default', label: t("settings.appearance.useDefault") },
    ...presetThemes
      .filter(t => t.id !== 'default')
      .map(t => ({
        value: t.id,
        label: t.theme.name || t.id,
      })),
  ], [presetThemes, t])

  // Get current app default theme label for display (null when using 'default' to avoid redundant "Use Default (Default)")
  const appDefaultLabel = useMemo(() => {
    if (colorTheme === 'default') return null
    const preset = presetThemes.find(t => t.id === colorTheme)
    return preset?.theme.name || colorTheme
  }, [colorTheme, presetThemes])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t("settings.appearance.title")}
        actions={<HeaderMenu route={routes.view.settings('appearance')} helpFeature="themes" />}
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {/* Default Theme */}
              <SettingsSection title={t("settings.appearance.defaultTheme")}>
                <SettingsCard>
                  <SettingsRow label={t("settings.appearance.mode")}>
                    <SettingsSegmentedControl
                      value={mode}
                      onValueChange={setMode}
                      options={[
                        { value: 'system', label: t("settings.appearance.system"), icon: <Monitor className="w-4 h-4" /> },
                        { value: 'light', label: t("settings.appearance.light"), icon: <Sun className="w-4 h-4" /> },
                        { value: 'dark', label: t("settings.appearance.dark"), icon: <Moon className="w-4 h-4" /> },
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={t("settings.appearance.colorTheme")}>
                    <SettingsMenuSelect
                      value={colorTheme}
                      onValueChange={(id) => { setThemePack(null); setColorTheme(id) }}
                      options={themeOptions}
                    />
                  </SettingsRow>
                  <ThemePresetGallery themes={presetThemes} selected={themePackId ? null : colorTheme} dark={isDark} onSelect={(id) => { setThemePack(null); setColorTheme(id) }} />
                  <SettingsRow label={t("settings.appearance.font")}>
                    <SettingsSegmentedControl
                      value={font}
                      onValueChange={setFont}
                      options={[
                        { value: 'inter', label: t("settings.appearance.fontInter") },
                        { value: 'system', label: t("settings.appearance.fontSystem") },
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow
                    label={t('settings.appearance.chatPanelOpacity')}
                    description={t('settings.appearance.chatPanelOpacityDesc')}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        aria-label={t('settings.appearance.chatPanelOpacity')}
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={Math.round(chatPanelOpacity * 100)}
                        onChange={event => setChatPanelOpacity(Number(event.target.value) / 100)}
                        className="w-32 accent-accent"
                      />
                      <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
                        {Math.round(chatPanelOpacity * 100)}%
                      </span>
                    </div>
                  </SettingsRow>
                  <SettingsRow
                    label={t("settings.appearance.chatOpacity")}
                    description={t("settings.appearance.chatOpacityDesc")}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        aria-label={t("settings.appearance.chatOpacity")}
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={Math.round(chatOpacity * 100)}
                        onChange={(event) => setChatOpacity(Number(event.target.value) / 100)}
                        className="w-32 accent-accent"
                      />
                      <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
                        {Math.round(chatOpacity * 100)}%
                      </span>
                    </div>
                  </SettingsRow>
                </SettingsCard>
                {themePackId && <p className="mt-2 text-xs text-muted-foreground">{t('settings.appearance.packPaletteNotice')}</p>}
                {!themePackId && <ThemePresentationSettings />}
                {themeLoadError && (
                  <p className="mt-2 text-xs text-info">
                    {t("settings.appearance.themeWarning")} {themeLoadError} ({themeResolvedFrom === 'fallback' ? t("settings.appearance.usingBundledFallback") : t("settings.appearance.usingDefaultTheme")})
                  </p>
                )}
              </SettingsSection>

              {/* Workspace Themes */}
              {workspaces.length > 0 && (
                <SettingsSection
                  title={t("settings.appearance.workspaceThemes")}
                  description={t("settings.appearance.workspaceThemesDesc")}
                >
                  <SettingsCard>
                    {workspaces.map((workspace) => {
                      const wsTheme = workspaceThemes[workspace.id]
                      const hasCustomTheme = wsTheme !== undefined
                      return (
                        <SettingsRow
                          key={workspace.id}
                          label={
                            <div className="flex items-center gap-2">
                              <ColorPicker
                                value={workspaceAvatarColors[workspace.id] || ''}
                                onChange={(hex) => setWorkspaceAvatarColor(workspace.id, hex)}
                                onClear={() => clearWorkspaceAvatarColor(workspace.id)}
                                clearLabel={t("settings.appearance.workspaceAvatarReset")}
                                presets={PROJECT_COLOR_PALETTE}
                                ariaLabel={t("settings.appearance.workspaceAvatarColor")}
                                trigger={
                                  <button
                                    type="button"
                                    className="cursor-pointer rounded hover:ring-2 hover:ring-foreground/20 transition-shadow"
                                    aria-label={t("settings.appearance.workspaceAvatarColor")}
                                  >
                                    <WorkspaceAvatar
                                      workspaceId={workspace.id}
                                      workspaceName={workspace.name}
                                      src={workspaceIconMap.get(workspace.id)}
                                      className="w-4 h-4 rounded"
                                    />
                                  </button>
                                }
                              />
                              <span>{workspace.name}</span>
                            </div>
                          }
                        >
                          <SettingsMenuSelect
                            value={hasCustomTheme ? wsTheme : 'default'}
                            onValueChange={(value) => handleWorkspaceThemeChange(workspace.id, value)}
                            options={[
                              { value: 'default', label: appDefaultLabel ? t("settings.appearance.useDefaultWithTheme", { theme: appDefaultLabel }) : t("settings.appearance.useDefault") },
                              ...presetThemes
                                .filter(t => t.id !== 'default')
                                .map(t => ({
                                  value: t.id,
                                  label: t.theme.name || t.id,
                                })),
                            ]}
                          />
                        </SettingsRow>
                      )
                    })}
                  </SettingsCard>
                </SettingsSection>
              )}

              {/* Theme Packs */}
              <SettingsSection
                title={t("settings.appearance.themePacks")}
                description={t("settings.appearance.themePacksDesc")}
              >
                <SettingsCard>
                  <SettingsRow label={t("settings.appearance.themePackActive")}>
                    <SettingsMenuSelect
                      value={themePackId ?? 'none'}
                      onValueChange={(value) => setThemePack(value === 'none' ? null : value)}
                      options={[
                        { value: 'none', label: t("settings.appearance.themePackNone") },
                        ...themePacks.map((pack) => ({
                          value: pack.id,
                          label: pack.manifest.name || pack.id,
                        })),
                      ]}
                    />
                  </SettingsRow>

                  {themePacks.length > 0 && (
                    <div className="grid gap-3 px-4 py-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))' }}>
                      {visibleThemePacks.map((pack: ThemePack) => (
                        <div
                          key={pack.id}
                          className={
                            "flex flex-col overflow-hidden rounded-xl border " +
                            (pack.id === themePackId
                              ? "border-accent bg-accent/5"
                              : "border-foreground/10")
                          }
                        >
                          {packPreviews[pack.id] ? (
                            <img
                              src={packPreviews[pack.id]}
                              alt={pack.manifest.name}
                              loading="lazy"
                              className="aspect-[8/5] w-full object-cover"
                            />
                          ) : (
                            <div className="aspect-[8/5] w-full bg-foreground/5" />
                          )}
                          <div className="flex-1 min-w-0 p-3">
                            <div className="text-sm font-medium">
                              {pack.manifest.name}
                              {pack.source === 'dsh' && (
                                <Info_Badge color="muted" className="ml-2">dsh</Info_Badge>
                              )}
                              {pack.location === 'builtin' && (
                                <Info_Badge color="muted" className="ml-2">{t("settings.promptOverview.source.builtin")}</Info_Badge>
                              )}
                            </div>
                            {(pack.manifest.tagline || pack.manifest.author) && (
                              <div className="mt-1 text-xs text-muted-foreground">
                                {pack.manifest.tagline ?? pack.manifest.author}
                              </div>
                            )}
                            {pack.manifest.artwork?.map(art => <div key={art.sourceUrl} className="mt-2 text-[10px] leading-relaxed text-muted-foreground/80">{art.credit}</div>)}
                          </div>
                          <div className="flex items-center justify-between gap-2 border-t border-foreground/5 px-3 py-2">
                          {pack.id === themePackId ? (
                            <Info_Badge color="success">{t("settings.appearance.themePackInUse")}</Info_Badge>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setThemePack(pack.id)}
                            >
                              {t("settings.appearance.themePackApply")}
                            </Button>
                          )}
                          {pack.location !== 'builtin' && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t("settings.appearance.themePackDelete")}
                              onClick={() => void deleteThemePack(pack.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <CatalogPagination
                    page={currentThemePackPage}
                    pageSize={THEME_PACK_PAGE_SIZE}
                    total={themePacks.length}
                    onPageChange={setThemePackPage}
                  />

                  <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleImportPack()}
                      disabled={importingPack}
                    >
                      <PackagePlus className="mr-1.5 h-4 w-4" />
                      {t("settings.appearance.themePackImport")}
                    </Button>
                    <Button variant="outline" size="sm" disabled={importingPack}
                      onClick={() => void handleImportPack('folder')}>
                      <FolderOpen className="mr-1.5 h-4 w-4" />
                      {t('settings.appearance.themePackImportFolder')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void handleOpenPacksFolder()}>
                      <FolderOpen className="mr-1.5 h-4 w-4" />
                      {t("settings.appearance.themePackOpenFolder")}
                    </Button>
                  </div>
                  <div className="border-t border-foreground/10 py-1">
                    <SettingsToggle
                      label={t("settings.appearance.themePackScripts")}
                      description={t("settings.appearance.themePackScriptsDesc")}
                      checked={themePackScriptsEnabled}
                      onCheckedChange={setThemePackScriptsEnabled}
                    />
                  </div>
                </SettingsCard>
                {themePackId && <ThemePresentationSettings />}
              </SettingsSection>

              <BirdCompanionSettings />

              {/* Interface */}
              <SettingsSection title={t("settings.appearance.interface")}>
                <SettingsCard>
                  <SettingsRow label={t('settings.appearance.modelGroupExpansion')}>
                    <SettingsMenuSelect
                      value={modelGroupExpansion}
                      onValueChange={value => {
                        if (value === 'current' || value === 'all-expanded' || value === 'all-collapsed') {
                          setModelGroupExpansion(value)
                        }
                      }}
                      options={[
                        { value: 'current', label: t('settings.appearance.modelGroupCurrent') },
                        { value: 'all-expanded', label: t('settings.appearance.modelGroupAllExpanded') },
                        { value: 'all-collapsed', label: t('settings.appearance.modelGroupAllCollapsed') },
                      ]}
                    />
                  </SettingsRow>
                  <SettingsToggle
                    label={t("settings.appearance.connectionIcons")}
                    description={t("settings.appearance.connectionIconsDesc")}
                    checked={showConnectionIcons}
                    onCheckedChange={handleConnectionIconsChange}
                  />
                  <SettingsToggle
                    label={t("settings.appearance.backgroundFinishedChip")}
                    description={t("settings.appearance.backgroundFinishedChipDesc")}
                    checked={showBackgroundFinishedChip}
                    onCheckedChange={setShowBackgroundFinishedChip}
                  />
                  <SettingsRow
                    label={t("settings.appearance.projectColorTreatment")}
                    description={t("settings.appearance.projectColorTreatmentDesc")}
                  >
                    <SettingsMenuSelect
                      value={projectColorTreatment}
                      onValueChange={handleProjectColorTreatmentChange}
                      options={[
                        { value: 'stripe', label: t("settings.appearance.projectColorStripe") },
                        { value: 'stripe-tint', label: t("settings.appearance.projectColorStripeTint") },
                      ]}
                    />
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              {/* Kanban board — column colors + live-pulse toggle */}
              <SettingsSection
                title={t("settings.appearance.kanbanBoard")}
                description={t("settings.appearance.kanbanBoardDesc")}
              >
                <SettingsCard>
                  {KANBAN_COLUMNS.map(column => {
                    const merged = kanbanColumnColors[column.id] ?? DEFAULT_KANBAN_COLUMN_COLORS[column.id]
                    return (
                      <SettingsRow key={column.id} label={t(column.labelKey)}>
                        <ColorPicker
                          value={merged}
                          onChange={(hex) => setKanbanColumnColor(column.id, hex)}
                          onClear={kanbanColumnColors[column.id] ? () => resetKanbanColumnColor(column.id) : undefined}
                          clearLabel={t("settings.appearance.kanbanColumnColorReset")}
                          presets={PROJECT_COLOR_PALETTE}
                          ariaLabel={t("settings.appearance.kanbanColumnColor", { column: t(column.labelKey) })}
                          align="end"
                        />
                      </SettingsRow>
                    )
                  })}
                  <SettingsToggle
                    label={t("settings.appearance.kanbanLivePulse")}
                    description={t("settings.appearance.kanbanLivePulseDesc")}
                    checked={kanbanLivePulse}
                    onCheckedChange={setKanbanLivePulse}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Kanban status automation — status applied on drag into a column */}
              <SettingsSection
                title={t("settings.appearance.kanbanColumnStatus")}
                description={t("settings.appearance.kanbanColumnStatusDesc")}
              >
                <SettingsCard>
                  {KANBAN_COLUMNS.map(column => (
                    <SettingsRow key={column.id} label={t(column.labelKey)}>
                      <SettingsMenuSelect
                        value={kanbanColumnStatus[column.id] ?? ''}
                        onValueChange={(value) => setColumnStatus(column.id, value)}
                        options={columnStatusOptions}
                      />
                    </SettingsRow>
                  ))}
                </SettingsCard>
              </SettingsSection>

              {/* Tool Icons — shows the command → icon mapping used in turn cards */}
              <SettingsSection
                title={t("settings.appearance.toolIcons")}
                description={t("settings.appearance.toolIconsDesc")}
                action={
                  toolIconsJsonPath ? (
                    <EditPopover
                      trigger={<EditButton />}
                      {...getEditConfig('edit-tool-icons', toolIconsJsonPath)}
                      secondaryAction={{
                        label: t("settings.appearance.editFile"),
                        filePath: toolIconsJsonPath,
                      }}
                    />
                  ) : undefined
                }
              >
                <SettingsCard>
                  <Info_DataTable
                    columns={toolIconColumns}
                    data={toolIcons}
                    searchable={{ placeholder: t("settings.appearance.searchTools") }}
                    maxHeight={480}
                    emptyContent={t("settings.appearance.noToolIcons")}
                  />
                </SettingsCard>
              </SettingsSection>

            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { DatabaseZap, Download, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { deriveConnectionStatus } from '@/components/ui/source-status-indicator'
import { EntityPanel } from '@/components/ui/entity-panel'
import { EntityListBadge } from '@/components/ui/entity-list-badge'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { sourceSelection } from '@/hooks/useEntitySelection'
import { SourceMenu } from './SourceMenu'
import { SendResourceToWorkspaceDialog } from './SendResourceToWorkspaceDialog'
import { useAppShellContext } from '@/context/AppShellContext'
import { EditPopover, getEditConfig, type EditContextKey } from '@/components/ui/EditPopover'
import type { LoadedSource, SourceConnectionStatus, SourceFilter } from '../../../shared/types'

const SOURCE_TYPE_CONFIG: Record<string, { labelKey: string; colorClass: string }> = {
  mcp: { labelKey: 'sourcesList.typeMcp', colorClass: 'bg-accent/10 text-accent' },
  api: { labelKey: 'sourcesList.typeApi', colorClass: 'bg-success/10 text-success' },
  local: { labelKey: 'sourcesList.typeLocal', colorClass: 'bg-info/10 text-info' },
}

const SOURCE_STATUS_CONFIG: Record<string, { labelKey: string; colorClass: string } | null> = {
  connected: null,
  needs_auth: { labelKey: 'sourcesList.statusAuthRequired', colorClass: 'bg-warning/10 text-warning' },
  failed: { labelKey: 'sourcesList.statusDisconnected', colorClass: 'bg-destructive/10 text-destructive' },
  untested: { labelKey: 'sourcesList.statusNotTested', colorClass: 'bg-foreground/10 text-foreground/50' },
  local_disabled: { labelKey: 'sourcesList.statusDisabled', colorClass: 'bg-foreground/10 text-foreground/50' },
}

const SOURCE_TYPE_FILTER_LABEL_KEYS: Record<string, string> = {
  api: 'sourcesList.filterApi',
  mcp: 'sourcesList.filterMcp',
  local: 'sourcesList.filterLocalFolder',
}

export interface SourcesListPanelProps {
  sources: LoadedSource[]
  sourceFilter?: SourceFilter | null
  workspaceRootPath?: string
  onDeleteSource: (sourceSlug: string) => void
  onSourceClick: (source: LoadedSource) => void
  selectedSourceSlug?: string | null
  localMcpEnabled?: boolean
  className?: string
}

export function SourcesListPanel({
  sources,
  sourceFilter,
  workspaceRootPath,
  onDeleteSource,
  onSourceClick,
  selectedSourceSlug,
  localMcpEnabled = true,
  className,
}: SourcesListPanelProps) {
  const { t } = useTranslation()
  const { workspaces, activeWorkspaceId } = useAppShellContext()
  const hasOtherWorkspaces = workspaces.length > 1

  // Send to Workspace dialog state
  const [sendDialogOpen, setSendDialogOpen] = React.useState(false)
  const [sendResourceSlug, setSendResourceSlug] = React.useState<string | null>(null)
  const [sendResourceLabel, setSendResourceLabel] = React.useState('')

  // Bundle archive (打包存档 / 一键导入) state
  const [bundleBusy, setBundleBusy] = React.useState<'export' | 'import' | null>(null)

  const handleExportBundle = React.useCallback(async () => {
    if (!activeWorkspaceId) return
    setBundleBusy('export')
    try {
      const result = await window.electronAPI.exportResourcesToFile(activeWorkspaceId, {
        sources: 'all',
        skills: 'all',
        automations: true,
      })
      if ('canceled' in result) return
      toast.success(t('sourcesList.bundleExportedTitle'), {
        description: result.filePath,
      })
    } catch (error) {
      toast.error(t('sourcesList.bundleExportFailed'), {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBundleBusy(null)
    }
  }, [activeWorkspaceId, t])

  const handleImportBundle = React.useCallback(async () => {
    if (!activeWorkspaceId) return
    setBundleBusy('import')
    try {
      const result = await window.electronAPI.importResourcesFromFile(activeWorkspaceId)
      if (!result || 'canceled' in result) return
      const imported = result.sources.imported.length + result.skills.imported.length + result.automations.imported.length
      const skipped = result.sources.skipped.length + result.skills.skipped.length + result.automations.skipped.length
      const failed = result.sources.failed.length + result.skills.failed.length + result.automations.failed.length
      if (imported > 0) {
        toast.success(t('sourcesList.bundleImportedTitle'), {
          description: t('sourcesList.bundleImportedDetail', { imported, skipped, failed }),
        })
      } else if (skipped > 0) {
        toast.info(t('sourcesList.bundleImportedTitle'), {
          description: t('sourcesList.bundleImportedDetail', { imported, skipped, failed }),
        })
      } else {
        toast.warning(t('sourcesList.bundleImportedTitle'), {
          description: t('sourcesList.bundleImportedDetail', { imported, skipped, failed }),
        })
      }
    } catch (error) {
      toast.error(t('sourcesList.bundleImportFailed'), {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBundleBusy(null)
    }
  }, [activeWorkspaceId, t])

  const filteredSources = React.useMemo(() => {
    if (!sourceFilter) return sources
    return sources.filter(s => s.config.type === sourceFilter.sourceType)
  }, [sources, sourceFilter])

  const emptyMessage = React.useMemo(() => {
    if (sourceFilter?.kind === 'type') {
      const filterLabelKey = SOURCE_TYPE_FILTER_LABEL_KEYS[sourceFilter.sourceType]
      const filterLabel = filterLabelKey ? t(filterLabelKey) : sourceFilter.sourceType
      return t('sourcesList.noSourcesOfType', { type: filterLabel })
    }
    return t('sourcesList.noSourcesConfigured')
  }, [sourceFilter, t])

  return (
    <>
    {/* Bundle archive toolbar: package integrations into a portable file or import one */}
    {activeWorkspaceId && (
      <div className="flex items-center gap-2 px-3 pt-2">
        <button
          className="inline-flex items-center h-7 px-2.5 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors disabled:opacity-50"
          disabled={bundleBusy !== null}
          onClick={() => void handleExportBundle()}
        >
          <Download className="h-3.5 w-3.5 mr-1.5" />
          {t('sourcesList.exportBundle')}
        </button>
        <button
          className="inline-flex items-center h-7 px-2.5 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors disabled:opacity-50"
          disabled={bundleBusy !== null}
          onClick={() => void handleImportBundle()}
        >
          <Upload className="h-3.5 w-3.5 mr-1.5" />
          {t('sourcesList.importBundle')}
        </button>
      </div>
    )}
    <EntityPanel<LoadedSource>
      items={filteredSources}
      getId={(s) => s.config.slug}
      selection={sourceSelection}
      selectedId={selectedSourceSlug}
      onItemClick={onSourceClick}
      className={className}
      containerProps={{ 'data-list-role': 'sources' }}
      emptyState={
        <EntityListEmptyScreen
          icon={<DatabaseZap />}
          title={emptyMessage}
          description={t('sourcesList.emptyDescription')}
          docKey="sources"
        >
          {workspaceRootPath && (
            <EditPopover
              align="center"
              trigger={
                <button className="inline-flex items-center h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors">
                  {t('sourcesList.addSource')}
                </button>
              }
              {...getEditConfig(
                sourceFilter?.kind === 'type' ? `add-source-${sourceFilter.sourceType}` as EditContextKey : 'add-source',
                workspaceRootPath
              )}
            />
          )}
        </EntityListEmptyScreen>
      }
      mapItem={(source) => {
        const connectionStatus = deriveConnectionStatus(source, localMcpEnabled)
        const typeConfig = SOURCE_TYPE_CONFIG[source.config.type]
        const statusConfig = SOURCE_STATUS_CONFIG[connectionStatus]
        const subtitle = source.config.tagline || source.config.provider || ''
        return {
          icon: <SourceAvatar source={source} size="sm" />,
          title: source.config.name,
          badges: (
            <>
              {typeConfig && <EntityListBadge colorClass={typeConfig.colorClass}>{t(typeConfig.labelKey)}</EntityListBadge>}
              {statusConfig && (
                <EntityListBadge colorClass={statusConfig.colorClass} tooltip={source.config.connectionError || undefined} className="cursor-default">
                  {t(statusConfig.labelKey)}
                </EntityListBadge>
              )}
              {subtitle && <span className="truncate">{subtitle}</span>}
            </>
          ),
          menu: (
            <SourceMenu
              sourceSlug={source.config.slug}
              sourceName={source.config.name}
              onOpenInNewWindow={() => window.electronAPI.openUrl(`craftagents://sources/source/${source.config.slug}?window=focused`)}
              onShowInFinder={() => window.electronAPI.showInFolder(source.folderPath)}
              onDelete={() => onDeleteSource(source.config.slug)}
              onSendToWorkspace={hasOtherWorkspaces ? () => {
                setSendResourceSlug(source.config.slug)
                setSendResourceLabel(source.config.name)
                setSendDialogOpen(true)
              } : undefined}
            />
          ),
        }
      }}
    />

    {/* Send to Workspace dialog */}
    {sendResourceSlug && (
      <SendResourceToWorkspaceDialog
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        resourceType="source"
        resourceIds={[sendResourceSlug]}
        resourceLabel={sendResourceLabel}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
      />
    )}
    </>
  )
}

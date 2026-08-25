/**
 * AutomationInfoPage
 *
 * Detail view for a selected automation, using the Info_Page compound component system.
 * Follows SourceInfoPage pattern: Hero → Sections (When, Then, Settings, History, JSON).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { PauseCircle, Hash, Settings2 } from 'lucide-react'
import {
  Info_Page,
  Info_Section,
  Info_Table,
  Info_Alert,
  Info_Badge,
  Info_Markdown,
} from '@/components/info'
import { EditPopover, EditButton, getEditConfig } from '@/components/ui/EditPopover'
import { Button } from '@/components/ui/button'
import { useActiveWorkspace, useAppShellContext } from '@/context/AppShellContext'
import { AutomationAvatar } from './AutomationAvatar'
import { AutomationMenu } from './AutomationMenu'
import { AutomationActionRow } from './AutomationActionRow'
import { AutomationTestPanel } from './AutomationTestPanel'
import { AutomationEventTimeline } from './AutomationEventTimeline'
import { PhaseBadge } from './PhaseBadge'
import { getEventDisplayName, getPermissionDisplayName, flattenConditions, type AutomationListItem, type ExecutionEntry, type TestResult } from './types'
import { describeCron, computeNextRuns } from './utils'
import { AutomationConfigDialog } from './AutomationConfigDialog'

// ============================================================================
// Component
// ============================================================================

export interface AutomationInfoPageProps {
  automation: AutomationListItem
  executions?: ExecutionEntry[]
  testResult?: TestResult
  onToggleEnabled?: () => void
  onTest?: () => void
  onDuplicate?: () => void
  onDelete?: () => void
  onReplay?: (automationId: string, event: string) => void
  className?: string
}

export function AutomationInfoPage({
  automation,
  executions = [],
  testResult,
  onToggleEnabled,
  onTest,
  onDuplicate,
  onDelete,
  onReplay,
  className,
}: AutomationInfoPageProps) {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()
  const { llmConnections } = useAppShellContext()
  const [configOpen, setConfigOpen] = React.useState(false)
  const nextRuns = automation.cron ? computeNextRuns(automation.cron) : []
  const promptAction = automation.actions.find(action => action.type === 'prompt')

  // Lightweight per-mount fetch — mirrors the pattern used in MessagingSettingsPage.
  // Only fired when the matcher actually declares a topic to avoid unnecessary IPC.
  const [hasSupergroup, setHasSupergroup] = React.useState<boolean | null>(null)
  React.useEffect(() => {
    if (!automation.telegramTopic) {
      setHasSupergroup(null)
      return
    }
    let cancelled = false
    void window.electronAPI.getMessagingSupergroup().then((sg) => {
      if (!cancelled) setHasSupergroup(Boolean(sg?.chatId))
    }).catch(() => {
      if (!cancelled) setHasSupergroup(false)
    })
    return () => {
      cancelled = true
    }
  }, [automation.telegramTopic])

  const editActions = workspace?.rootPath ? (
    <div className="flex items-center gap-2">
      {(automation.event === 'SchedulerTick' || automation.event === 'HostedScriptTick') && (
        <Button variant="outline" size="sm" onClick={() => setConfigOpen(true)}>
          <Settings2 className="size-3.5" />
          Configure
        </Button>
      )}
      <EditPopover
        trigger={<EditButton />}
        {...getEditConfig('automation-config', workspace.rootPath)}
        secondaryAction={{ label: t('automations.editFile'), filePath: `${workspace.rootPath}/automations.json` }}
      />
    </div>
  ) : undefined

  return (
    <Info_Page className={className}>
      <Info_Page.Header
        title={automation.name}
        titleMenu={
          <AutomationMenu
            automationId={automation.id}
            automationName={automation.name}
            enabled={automation.enabled}
            onToggleEnabled={onToggleEnabled}
            onTest={onTest}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
          />
        }
      />

      <Info_Page.Content>
        {/* Hero */}
        <div className="flex items-start justify-between">
          <Info_Page.Hero
            avatar={<AutomationAvatar event={automation.event} fluid />}
            title={automation.name}
            tagline={automation.summary}
          />
          {editActions}
        </div>

        {/* Disabled warning */}
        {!automation.enabled && (
          <Info_Alert variant="warning" icon={<PauseCircle className="h-4 w-4" />}>
            <Info_Alert.Title>{t('automations.pausedTitle')}</Info_Alert.Title>
            <Info_Alert.Description>
              {t('automations.pausedDescription')}
            </Info_Alert.Description>
          </Info_Alert>
        )}

        {/* Section: When */}
        <Info_Section
          title={t('automations.sectionWhen')}
          description={t('automations.sectionWhenDescription')}
          actions={editActions}
        >
          <Info_Table>
            <Info_Table.Row label={t('automations.labelEvent')}>
              <Info_Badge color="default">{getEventDisplayName(automation.event)}</Info_Badge>
            </Info_Table.Row>
            <Info_Table.Row label={t('automations.labelTiming')}>
              <PhaseBadge event={automation.event} />
            </Info_Table.Row>
            {automation.matcher && (
              <Info_Table.Row label={t('automations.labelOnlyWhenMatching')}>
                <code className="text-xs font-mono bg-foreground/5 px-1.5 py-0.5 rounded">
                  {automation.matcher}
                </code>
              </Info_Table.Row>
            )}
            {automation.cron && (
              <>
                <Info_Table.Row label={t('automations.labelRepeats')} value={describeCron(automation.cron)} />
                <Info_Table.Row label={t('automations.labelScheduleExpression')}>
                  <code className="text-xs font-mono bg-foreground/5 px-1.5 py-0.5 rounded">
                    {automation.cron}
                  </code>
                </Info_Table.Row>
                {nextRuns.length > 0 && (
                  <Info_Table.Row label={t('automations.labelNextRuns')}>
                    <div className="flex flex-col gap-0.5">
                      {(() => {
                        const spansYears = nextRuns.length > 1 && nextRuns[0].getFullYear() !== nextRuns[nextRuns.length - 1].getFullYear()
                        return nextRuns.map((date, i) => (
                          <span key={i} className="text-sm text-foreground/70">
                            {date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(spansYears && { year: 'numeric' }) })}{' '}
                            {date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
                          </span>
                        ))
                      })()}
                    </div>
                  </Info_Table.Row>
                )}
                <Info_Table.Row label={t('automations.labelTimezone')} value={automation.timezone || t('automations.systemDefault')} />
              </>
            )}
            {automation.event === 'HostedScriptTick' && (
              <>
                <Info_Table.Row label="Interval" value={formatInterval(automation.intervalMs)} />
                <Info_Table.Row label="Script timeout" value={`${automation.scriptTimeoutMs ?? 2000} ms`} />
                <Info_Table.Row label="Sandbox permissions" value={formatScriptPermissions(automation.scriptPermissions)} />
              </>
            )}
          </Info_Table>
        </Info_Section>

        {/* Section: If (conditions) — hidden when empty */}
        {automation.conditions && automation.conditions.length > 0 && (
          <Info_Section
            title={t('automations.sectionIf')}
            description={t('automations.sectionIfDescription')}
            actions={editActions}
          >
            <Info_Table>
              {flattenConditions(automation.conditions).map((row, i) => (
                <Info_Table.Row key={i} label={row.label}>
                  <span className="text-sm text-foreground/70">
                    {row.description}
                  </span>
                </Info_Table.Row>
              ))}
            </Info_Table>
          </Info_Section>
        )}

        {/* Section: Then */}
        <Info_Section
          title={t('automations.sectionThen')}
          description={t('automations.sectionThenDescription', { count: automation.actions.length })}
          actions={editActions}
        >
          <div className="divide-y divide-border/30">
            {automation.actions.map((action, i) => (
              <AutomationActionRow key={i} action={action} index={i} />
            ))}
          </div>
        </Info_Section>

        {/* Test results (if any) */}
        {testResult && testResult.state !== 'idle' && (
          <AutomationTestPanel result={testResult} />
        )}

        {/* Section: Settings */}
        <Info_Section title={t('automations.sectionSettings')} actions={editActions}>
          <Info_Table>
            <Info_Table.Row label={t('automations.labelAccessLevel')} value={getPermissionDisplayName(automation.permissionMode)} />
            {(promptAction?.llmConnection || automation.provider) && <Info_Table.Row label="Provider" value={promptAction?.llmConnection || automation.provider} />}
            {promptAction?.model && <Info_Table.Row label="Model" value={promptAction.model} />}
            {promptAction?.thinkingLevel && <Info_Table.Row label="Thinking" value={promptAction.thinkingLevel} />}
            <Info_Table.Row label={t('automations.labelStatus')}>
              <Info_Badge color={automation.enabled ? 'success' : 'muted'}>
                {automation.enabled ? t('automations.statusActive') : t('automations.statusDisabled')}
              </Info_Badge>
            </Info_Table.Row>
            {automation.labels && automation.labels.length > 0 && (
              <Info_Table.Row label={t('automations.labelLabels')}>
                <div className="flex gap-1.5 flex-wrap">
                  {automation.labels.map((l) => (
                    <Info_Badge key={l} color="muted">{l}</Info_Badge>
                  ))}
                </div>
              </Info_Table.Row>
            )}
            {automation.telegramTopic && (
              <Info_Table.Row label={t('automations.labelTelegramTopic')}>
                <div className="flex flex-col gap-1">
                  <div className="inline-flex items-center gap-1.5 text-foreground">
                    <Hash className="size-3.5 text-foreground/50" />
                    <span className="font-mono text-xs">{automation.telegramTopic}</span>
                  </div>
                  <span className="text-xs text-foreground/50">
                    {hasSupergroup === false
                      ? t('automations.telegramTopicHintNoSupergroup')
                      : t('automations.telegramTopicHintBound')}
                  </span>
                </div>
              </Info_Table.Row>
            )}
          </Info_Table>
        </Info_Section>

        {/* Section: Recent Activity */}
        <Info_Section
          title={t('automations.sectionRecentActivity')}
          description={executions.length > 0 ? t('automations.lastNRuns', { count: executions.length }) : undefined}
        >
          <AutomationEventTimeline entries={executions} onReplay={onReplay} />
        </Info_Section>

        {/* Section: Raw config (JSON) */}
        <Info_Section title={t('automations.sectionRawConfig')}>
          <div className="rounded-[8px] shadow-minimal overflow-hidden [&_pre]:!bg-transparent [&_.relative]:!bg-transparent [&_.relative]:!border-0 [&_.relative>div:first-child]:!bg-transparent [&_.relative>div:first-child]:!border-0">
            <Info_Markdown maxHeight={300} fullscreen>
              {`\`\`\`json\n${JSON.stringify({
                event: automation.event,
                matcher: automation.matcher,
                conditions: automation.conditions,
                cron: automation.cron,
                timezone: automation.timezone,
                permissionMode: automation.permissionMode,
                provider: automation.provider,
                script: automation.script,
                intervalMs: automation.intervalMs,
                scriptTimeoutMs: automation.scriptTimeoutMs,
                scriptMetadata: automation.scriptMetadata,
                scriptPermissions: automation.scriptPermissions,
                labels: automation.labels,
                telegramTopic: automation.telegramTopic,
                enabled: automation.enabled,
                actions: automation.actions,
              }, null, 2)}\n\`\`\``}
            </Info_Markdown>
          </div>
        </Info_Section>
        {workspace && (
          <AutomationConfigDialog
            open={configOpen}
            onOpenChange={setConfigOpen}
            automation={automation}
            workspaceId={workspace.id}
            connections={llmConnections}
          />
        )}
      </Info_Page.Content>
    </Info_Page>
  )
}

function formatScriptPermissions(permissions?: { env?: string[]; filesystem?: string[]; network?: string[] }): string {
  if (!permissions || (!permissions.env?.length && !permissions.filesystem?.length && !permissions.network?.length)) return 'None'
  const parts: string[] = []
  if (permissions.env?.length) parts.push(`${permissions.env.length} env`)
  if (permissions.filesystem?.length) parts.push(`${permissions.filesystem.length} file path${permissions.filesystem.length === 1 ? '' : 's'}`)
  if (permissions.network?.length) parts.push(`${permissions.network.length} network origin${permissions.network.length === 1 ? '' : 's'}`)
  return parts.join(', ')
}

function formatInterval(intervalMs?: number): string {
  if (!intervalMs) return 'Not configured'
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000} hr`
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000} min`
  return `${intervalMs / 1000} sec`
}

/**
 * Settings Page Components Registry
 *
 * Maps settings subpage IDs to their React components.
 * TypeScript enforces that all pages defined in settings-registry have a component here.
 *
 * To add a new settings page:
 * 1. Add to SETTINGS_PAGES in shared/settings-registry.ts
 * 2. Create the page component (e.g., NewSettingsPage.tsx)
 * 3. Add to SETTINGS_PAGE_COMPONENTS below
 * 4. Add icon to SETTINGS_ICONS in components/icons/SettingsIcons.tsx
 */

import type { ComponentType } from 'react'
import type { SettingsSubpage } from '../../../shared/settings-registry'

import AppSettingsPage from './AppSettingsPage'
import AiSettingsPage from './AiSettingsPage'
import AppearanceSettingsPage from './AppearanceSettingsPage'
import InputSettingsPage from './InputSettingsPage'
import WorkspaceSettingsPage from './WorkspaceSettingsPage'
import WorkspacePromptsPage from './WorkspacePromptsPage'
import PromptOverviewPage from './PromptOverviewPage'
import PermissionsSettingsPage from './PermissionsSettingsPage'
import ToolsSettingsPage from './ToolsSettingsPage'
import PerformanceSettingsPage from './PerformanceSettingsPage'
import GuidesSettingsPage from './GuidesSettingsPage'
import LabelsSettingsPage from './LabelsSettingsPage'
import MessagingSettingsPage from './MessagingSettingsPage'
import RemoteServersPage from './RemoteServersPage'
import ServerSettingsPage from './ServerSettingsPage'
import ShortcutsPage from './ShortcutsPage'
import PreferencesPage from './PreferencesPage'
import CollaborationManagementPage from './CollaborationManagementPage'

/**
 * Map of settings subpage IDs to their page components.
 * TypeScript will error if a page from SETTINGS_PAGES is missing here.
 */
export const SETTINGS_PAGE_COMPONENTS: Record<SettingsSubpage, ComponentType> = {
  app: AppSettingsPage,
  ai: AiSettingsPage,
  appearance: AppearanceSettingsPage,
  input: InputSettingsPage,
  workspace: WorkspaceSettingsPage,
  prompts: WorkspacePromptsPage,
  promptOverview: PromptOverviewPage,
  permissions: PermissionsSettingsPage,
  tools: ToolsSettingsPage,
  performance: PerformanceSettingsPage,
  guides: GuidesSettingsPage,
  labels: LabelsSettingsPage,
  messaging: MessagingSettingsPage,
  remoteServers: RemoteServersPage,
  server: ServerSettingsPage,
  shortcuts: ShortcutsPage,
  preferences: PreferencesPage,
  collaborations: CollaborationManagementPage,
}

/**
 * Get the component for a settings subpage
 */
export function getSettingsPageComponent(subpage: SettingsSubpage): ComponentType {
  return SETTINGS_PAGE_COMPONENTS[subpage]
}

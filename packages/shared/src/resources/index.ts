/**
 * Resource Bundle — Workspace resource export/import
 */

export type {
  ResourceBundle,
  SourceBundleEntry,
  SkillBundleEntry,
  AutomationBundleEntry,
  ResourceImportMode,
  ExportResourcesOptions,
  ExportResult,
  ImportBucketResult,
  ResourceImportResult,
  ResourceImportDeps,
} from './types.ts'

export {
  exportResources,
  importResources,
  validateResourceBundle,
} from './resource-bundle.ts'

export {
  RESOURCE_BUNDLE_FILE_MARKER,
  RESOURCE_BUNDLE_FILE_EXTENSION,
  stringifyResourceBundle,
  parseResourceBundle,
  writeResourceBundleFile,
  readResourceBundleFile,
} from './resource-file.ts'
export type { ResourceBundleFile } from './resource-file.ts'

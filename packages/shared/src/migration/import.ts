/**
 * Data import for cross-system migration (跨系统迁移数据).
 *
 * Restores archives produced by `exportAllData` on the current machine,
 * remapping absolute paths so imports succeed even when the backup was
 * created on a different OS (Windows ↔ macOS ↔ Linux):
 *   - Workspace `rootPath` entries are re-pointed at the local workspaces dir.
 *   - `defaults.workingDirectory` in workspace configs and `workingDirectory`
 *     / `sdkCwd` in session headers are rewritten when they lived inside the
 *     original workspace root.
 *   - Windows-only fields (gitBashPath) are dropped on non-Windows targets.
 *
 * Safety: archive entry paths are validated against path traversal before any
 * file is written; extraction happens into a staging dir and is only moved
 * into place after validation succeeds.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join, dirname, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { unzipSync } from 'fflate';
import { CONFIG_DIR } from '../config/paths.ts';
import { readJsonFileSync, atomicWriteFileSync } from '../utils/files.ts';
import { expandPath, toPortablePath } from '../utils/paths.ts';
import { getDefaultWorkspacesDir } from '../workspaces/storage.ts';
import type { WorkspaceConfig } from '../workspaces/types.ts';
import type { StoredConfig } from '../config/storage.ts';
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  sanitizeSegment,
  type ExportManifest,
} from './export.ts';

export interface ImportAllDataOptions {
  /** Absolute path of the backup .zip produced by exportAllData. */
  sourcePath: string;
  /** Target config dir (defaults to ~/.craft-agent). Test seam. */
  configDir?: string;
  /** Base dir where workspace app data is restored (default: default workspaces dir). */
  workspacesBaseDir?: string;
  onProgress?: (info: { files: number; currentFile: string }) => void;
}

export interface ImportedWorkspace {
  id: string;
  name: string;
  slug?: string;
  rootPath: string;
}

export interface ImportAllDataResult {
  fileCount: number;
  importedWorkspaces: ImportedWorkspace[];
  warnings: string[];
}

/** Accepted manifest format versions (v1 lacks per-workspace rootPath). */
const SUPPORTED_FORMAT_VERSIONS = [1, 2];

/**
 * Validate a ZIP entry name and split it into safe path parts.
 * Returns null when the entry could escape the staging dir.
 */
export function validateArchivePath(name: string): string[] | null {
  if (!name || name.length === 0) return null;
  // Tolerate Windows-style separators from foreign tools, then enforce '/'
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return null;
  if (/^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return parts;
}

/** Normalized comparison form: forward slashes, lowercase, no trailing slash. */
function normalizeForCompare(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** True when `path` is `root` or inside it (separator-agnostic). */
function isWithin(path: string, root: string): boolean {
  const a = normalizeForCompare(path);
  const b = normalizeForCompare(root);
  return a === b || a.startsWith(`${b}/`);
}

/** Relative suffix of `path` under `root` ('' when equal). */
function relativeUnder(path: string, root: string): string {
  const a = normalizeForCompare(path);
  const b = normalizeForCompare(root);
  if (a === b) return '';
  return a.slice(b.length + 1);
}

/**
 * Remap an absolute/portable path that lived under `oldRoot` onto `newRoot`.
 * Returns the input unchanged when it was not under oldRoot.
 */
function remapPathUnderOldRoot(
  value: string,
  oldRoot: string | undefined,
  newRoot: string,
): string {
  if (!oldRoot) return value;
  const expanded = expandPath(value);
  if (!isWithin(expanded, oldRoot)) return value;
  const rel = relativeUnder(expanded, oldRoot);
  return toPortablePath(rel ? join(newRoot, rel) : newRoot);
}

/** Move a directory, falling back to copy+remove across devices. */
function moveDir(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
}

/** Copy into the destination filesystem, then atomically publish the file there. */
export function moveFileIntoPlace(src: string, dest: string): void {
  const tempDest = join(
    dirname(dest),
    `.${basename(dest)}.craft-import-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    copyFileSync(src, tempDest);
    renameSync(tempDest, dest);
    unlinkSync(src);
  } finally {
    rmSync(tempDest, { force: true });
  }
}

/**
 * Decompress the archive into a staging dir, validating every entry path.
 * Returns the number of files written and a list of skipped (unsafe) entries.
 */
function extractToStaging(
  sourcePath: string,
  staging: string,
  onProgress?: ImportAllDataOptions['onProgress'],
): { fileCount: number; warnings: string[] } {
  const raw = readFileSync(sourcePath);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(raw));
  } catch (err) {
    throw new Error(
      `Failed to read archive (${err instanceof Error ? err.message : 'invalid zip'}). Not a valid Craft Agent backup?`,
    );
  }

  const warnings: string[] = [];
  let fileCount = 0;
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue; // directory marker
    const parts = validateArchivePath(name);
    if (!parts) {
      warnings.push(`Skipped unsafe archive entry: ${name}`);
      continue;
    }
    const target = join(staging, ...parts);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(data));
    fileCount += 1;
    onProgress?.({ files: fileCount, currentFile: name });
  }
  return { fileCount, warnings };
}

/**
 * Import a Craft Agent data backup into the current machine.
 */
export async function importAllData(
  options: ImportAllDataOptions,
): Promise<ImportAllDataResult> {
  const configDir = options.configDir ?? CONFIG_DIR;
  const workspacesBaseDir = options.workspacesBaseDir ?? getDefaultWorkspacesDir();

  if (!existsSync(options.sourcePath)) {
    throw new Error(`Archive not found: ${options.sourcePath}`);
  }
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspacesBaseDir, { recursive: true });

  // ---- Phase A: decompress into staging (validated, sandboxed) -------------
  const staging = mkdtempSync(join(tmpdir(), 'craft-agent-import-'));
  try {
    const staged = extractToStaging(options.sourcePath, staging, options.onProgress);
    const warnings = [...staged.warnings];

    // ---- Manifest -----------------------------------------------------------
    const manifestPath = join(staging, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error('Archive is not a Craft Agent backup (manifest.json missing).');
    }
    const manifest = readJsonFileSync<ExportManifest>(manifestPath);
    if (manifest.format !== EXPORT_FORMAT) {
      throw new Error(`Unsupported archive format: ${manifest.format ?? 'unknown'}`);
    }
    if (!SUPPORTED_FORMAT_VERSIONS.includes(manifest.formatVersion ?? 0)) {
      throw new Error(
        `Unsupported archive version ${manifest.formatVersion}; this build supports up to ${EXPORT_FORMAT_VERSION}.`,
      );
    }

    // ---- Workspaces ----------------------------------------------------------
    const stagedWsDir = join(staging, 'workspaces');
    const segments = existsSync(stagedWsDir)
      ? readdirSync(stagedWsDir).filter((d) => {
          try {
            return statSync(join(stagedWsDir, d)).isDirectory();
          } catch {
            return false;
          }
        })
      : [];

    const existingConfigPath = join(configDir, 'config.json');
    const existingConfig = existsSync(existingConfigPath)
      ? readJsonFileSync<StoredConfig>(existingConfigPath)
      : null;
    const existingIds = new Set(existingConfig?.workspaces?.map((w) => w.id) ?? []);
    const existingRoots = new Set(
      existingConfig?.workspaces?.map((w) => normalizeForCompare(w.rootPath)) ?? [],
    );

    const manifestWorkspaces = manifest.workspaces ?? [];

    // Read the archived global config once: used for workspace entry metadata
    // (icon/session ids) and for the final merge.
    const archivedConfigPath = join(staging, 'config', 'config.json');
    if (!existsSync(archivedConfigPath)) {
      throw new Error('Archive is missing config/config.json.');
    }
    const archivedConfig = readJsonFileSync<StoredConfig>(archivedConfigPath);

    const importedWorkspaces: ImportedWorkspace[] = [];
    const mergedEntries: StoredConfig['workspaces'] = [...(existingConfig?.workspaces ?? [])];

    for (const segment of segments) {
      const stagedWsPath = join(stagedWsDir, segment);
      const wsConfigPath = join(stagedWsPath, 'config.json');
      let wsConfig: WorkspaceConfig | null = null;
      try {
        wsConfig = readJsonFileSync<WorkspaceConfig>(wsConfigPath);
      } catch {
        warnings.push(`Workspace "${segment}" has no readable config.json; skipped.`);
        continue;
      }

      const id = wsConfig?.id ?? segment;
      const archivedEntry = manifestWorkspaces.find((w) => w.id === id);
      const oldRoot = archivedEntry?.rootPath;
      const archivedGlobalEntry = archivedConfig?.workspaces?.find((w) => w.id === id);

      // Never clobber a workspace that already exists locally.
      if (existingIds.has(id)) {
        warnings.push(
          `Workspace "${wsConfig?.name ?? segment}" already exists on this machine; skipped.`,
        );
        continue;
      }

      // Choose the restore path (never overwrite an unrelated existing dir).
      let finalRoot = join(workspacesBaseDir, sanitizeSegment(segment));
      if (existsSync(finalRoot) || existingRoots.has(normalizeForCompare(finalRoot))) {
        const alt = `${finalRoot}-${Date.now().toString(36)}`;
        warnings.push(
          `Target folder exists for workspace "${wsConfig?.name ?? segment}"; restored to ${alt}.`,
        );
        finalRoot = alt;
      }

      // Remap workingDirectory in the workspace config.
      let patched = false;
      if (wsConfig.defaults?.workingDirectory) {
        const remapped = remapPathUnderOldRoot(
          wsConfig.defaults.workingDirectory,
          oldRoot,
          finalRoot,
        );
        if (remapped !== wsConfig.defaults.workingDirectory) {
          wsConfig.defaults = { ...wsConfig.defaults, workingDirectory: remapped };
          patched = true;
        }
      }
      if (patched) {
        atomicWriteFileSync(wsConfigPath, JSON.stringify(wsConfig, null, 2));
      }

      // Remap session headers that pointed inside the old workspace root.
      const sessionsDir = join(stagedWsPath, 'sessions');
      if (existsSync(sessionsDir)) {
        patchSessionHeaders(sessionsDir, oldRoot, finalRoot);
      }

      moveDir(stagedWsPath, finalRoot);

      const entry: StoredConfig['workspaces'][number] = {
        id,
        name: wsConfig.name ?? id,
        slug: wsConfig.slug ?? segment,
        rootPath: finalRoot,
        createdAt: wsConfig.createdAt ?? Date.now(),
        ...(archivedGlobalEntry?.iconUrl ? { iconUrl: archivedGlobalEntry.iconUrl } : {}),
        ...(archivedGlobalEntry?.lastAccessedAt
          ? { lastAccessedAt: archivedGlobalEntry.lastAccessedAt }
          : {}),
      };
      mergedEntries.push(entry);
      importedWorkspaces.push({ id, name: entry.name, slug: entry.slug, rootPath: finalRoot });
    }

    // ---- Global config (merge) ----------------------------------------------
    const merged: StoredConfig = {
      ...(existingConfig ?? {}),
      ...archivedConfig,
      workspaces: mergedEntries,
    };
    // Prefer the local active workspace when one exists; otherwise restore the
    // archived one if it survived the merge.
    const activeOk =
      typeof merged.activeWorkspaceId === 'string' &&
      mergedEntries.some((w) => w.id === merged.activeWorkspaceId);
    if (existingConfig?.activeWorkspaceId && existingIds.has(existingConfig.activeWorkspaceId)) {
      merged.activeWorkspaceId = existingConfig.activeWorkspaceId;
    } else if (!activeOk) {
      merged.activeWorkspaceId = mergedEntries[0]?.id ?? null;
    }
    // Windows-only field is meaningless on other platforms.
    if (process.platform !== 'win32' && 'gitBashPath' in merged) {
      delete (merged as Partial<StoredConfig>).gitBashPath;
    }

    atomicWriteFileSync(existingConfigPath, JSON.stringify(merged, null, 2));

    // ---- Remaining global files (merge-friendly: never overwrite) -----------
    for (const name of ['preferences.json', 'drafts.json', 'window-state.json']) {
      const src = join(staging, 'config', name);
      const dst = join(configDir, name);
      if (existsSync(src) && !existsSync(dst)) {
        moveFileIntoPlace(src, dst);
      }
    }
    const stagedPermissions = join(staging, 'config', 'permissions');
    if (existsSync(stagedPermissions)) {
      const dstPermissions = join(configDir, 'permissions');
      mkdirSync(dstPermissions, { recursive: true });
      for (const name of readdirSync(stagedPermissions)) {
        const src = join(stagedPermissions, name);
        const dst = join(dstPermissions, name);
        if (!existsSync(dst)) {
          moveFileIntoPlace(src, dst);
        }
      }
    }
    const stagedCredentials = join(staging, 'config', 'credentials.enc');
    if (existsSync(stagedCredentials)) {
      const dstCredentials = join(configDir, 'credentials.enc');
      if (!existsSync(dstCredentials)) {
        moveFileIntoPlace(stagedCredentials, dstCredentials);
      } else {
        warnings.push(
          'credentials.enc was not restored because one already exists locally.',
        );
      }
    }

    return {
      fileCount: staged.fileCount,
      importedWorkspaces,
      warnings,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Rewrite `workingDirectory` / `sdkCwd` in every session.jsonl header that
 * pointed inside the original workspace root.
 */
function patchSessionHeaders(
  sessionsDir: string,
  oldRoot: string | undefined,
  newRoot: string,
): void {
  if (!oldRoot || !existsSync(sessionsDir)) return;
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jsonlPath = join(sessionsDir, entry.name, 'session.jsonl');
    if (!existsSync(jsonlPath)) continue;
    try {
      const raw = readFileSync(jsonlPath, 'utf-8');
      const nl = raw.indexOf('\n');
      const firstLine = nl === -1 ? raw : raw.slice(0, nl);
      const header = JSON.parse(firstLine) as Record<string, unknown>;
      let changed = false;
      for (const key of ['workingDirectory', 'sdkCwd']) {
        const value = header[key];
        if (typeof value !== 'string') continue;
        const remapped = remapPathUnderOldRoot(value, oldRoot, newRoot);
        if (remapped !== value) {
          header[key] = remapped;
          changed = true;
        }
      }
      if (changed) {
        writeFileSync(jsonlPath, JSON.stringify(header) + (nl === -1 ? '' : raw.slice(nl)));
      }
    } catch {
      // Unreadable session files are left untouched — resumption degrades
      // gracefully, and a hard failure here shouldn't block the import.
    }
  }
}

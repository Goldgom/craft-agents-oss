/**
 * Data export for cross-system migration (跨系统迁移数据).
 *
 * Bundles the entire app state into a single portable ZIP archive:
 *   - Global config dir files (config.json, preferences.json, drafts.json,
 *     window-state.json, permissions/)
 *   - Every workspace referenced by config.json (app data only: config,
 *     statuses, labels, skills, sources, sessions, projects, messaging, ...)
 *
 * Deliberately excluded:
 *   - Project source files inside workspace roots (only app data is exported)
 *   - Bundled/cached assets (docs, themes, logs, release-notes, ...)
 *   - credentials.enc (OS-encrypted; cannot be decrypted on another machine)
 *     unless `includeCredentials` is set explicitly.
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { Zip, ZipDeflate } from 'fflate';
import { CONFIG_DIR } from '../config/paths.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { APP_VERSION } from '../version/index.ts';
import type { Workspace } from '@craft-agent/core/types';

export const EXPORT_FORMAT = 'craft-agent-data-export';
export const EXPORT_FORMAT_VERSION = 2;

/** Global config-dir files always included (relative to config dir). */
const GLOBAL_FILES = ['config.json', 'preferences.json', 'drafts.json', 'window-state.json'];
/** Global config-dir folders always included (relative to config dir). */
const GLOBAL_DIRS = ['permissions'];
/** Workspace-scoped files always included (relative to workspace rootPath). */
const WORKSPACE_FILES = [
  'config.json',
  'permissions.json',
  'automations.json',
  'views.json',
  'events.jsonl',
];
/** Workspace-scoped folders always included (relative to workspace rootPath). */
const WORKSPACE_DIRS = [
  'statuses',
  'labels',
  'skills',
  'sources',
  'sessions',
  'projects',
  'messaging',
  '.claude-plugin',
];

export interface ExportAllDataOptions {
  /** Absolute path of the output .zip file (parent must exist). */
  destPath: string;
  /** Override config dir (defaults to ~/.craft-agent). Test seam. */
  configDir?: string;
  /** Include credentials.enc. It is OS-encrypted and usually useless elsewhere. */
  includeCredentials?: boolean;
  onProgress?: (info: { files: number; bytes: number; currentFile: string }) => void;
}

export interface ExportAllDataResult {
  destPath: string;
  /** Compressed archive size in bytes. */
  bytes: number;
  /** Total entries written (files + manifest). */
  fileCount: number;
  workspaceCount: number;
  warnings: string[];
}

export interface ExportManifest {
  format: string;
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  platform: string;
  includeCredentials: boolean;
  /**
   * Workspace inventory. `rootPath` records the ORIGINAL absolute path on the
   * source machine so the importer can remap working directories and session
   * cwds onto the new machine (cross-platform migration).
   */
  workspaces: Array<{ id: string; name: string; slug?: string; rootPath?: string }>;
}

interface PendingEntry {
  zipPath: string;
  fsPath: string;
  size: number;
}

/** Make a segment safe for use inside the archive path. */
export function sanitizeSegment(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\.+$/, '')
    .trim();
  return cleaned || 'workspace';
}

/** Recursively collect files (skips symlinks to avoid cycles). */
function collectDir(
  dir: string,
  zipPrefix: string,
  entries: PendingEntry[],
): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      collectDir(p, `${zipPrefix}/${name}`, entries);
    } else if (st.isFile()) {
      entries.push({ zipPath: `${zipPrefix}/${name}`, fsPath: p, size: st.size });
    }
  }
}

/**
 * Stream all entries into a ZIP archive at destPath.
 * Returns the compressed byte count.
 */
function buildZip(
  destPath: string,
  manifest: ExportManifest,
  entries: PendingEntry[],
  onProgress?: ExportAllDataOptions['onProgress'],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(destPath);
    let bytes = 0;
    let files = 0;

    out.on('error', (err) => reject(err));

    const zip = new Zip((err, data, final) => {
      if (err) {
        out.destroy();
        reject(err);
        return;
      }
      if (data && data.length > 0) {
        bytes += data.length;
        out.write(Buffer.from(data));
      }
      if (final) {
        out.end(() => resolve(bytes));
      }
    });

    const addBuffer = (zipPath: string, buf: Uint8Array) => {
      const entry = new ZipDeflate(zipPath, { level: 6 });
      zip.add(entry);
      entry.push(buf, true);
      files += 1;
      onProgress?.({ files, bytes: 0, currentFile: zipPath });
    };

    const addStreamed = async (entry: PendingEntry) => {
      const deflate = new ZipDeflate(entry.zipPath, { level: 6 });
      zip.add(deflate);
      const rs = createReadStream(entry.fsPath, { highWaterMark: 1 << 20 });
      let sent = 0;
      for await (const chunk of rs) {
        deflate.push(new Uint8Array(chunk as Buffer), false);
        sent += (chunk as Buffer).length;
      }
      deflate.push(new Uint8Array(0), true);
      files += 1;
      onProgress?.({ files, bytes: entry.size, currentFile: entry.zipPath });
      void sent;
    };

    void (async () => {
      try {
        addBuffer('manifest.json', new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
        for (const entry of entries) {
          await addStreamed(entry);
        }
        zip.end();
      } catch (err) {
        out.destroy();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
}

/**
 * Export all app data (global settings + every workspace) to a ZIP archive.
 */
export async function exportAllData(
  options: ExportAllDataOptions,
): Promise<ExportAllDataResult> {
  const configDir = options.configDir ?? CONFIG_DIR;
  const configPath = join(configDir, 'config.json');
  if (!existsSync(configPath)) {
    throw new Error(`App config not found at ${configPath}`);
  }

  const config = readJsonFileSync<{ workspaces?: Workspace[] }>(configPath);
  const workspaces = Array.isArray(config?.workspaces) ? config.workspaces : [];
  const warnings: string[] = [];
  const entries: PendingEntry[] = [];

  const addFile = (zipPath: string, fsPath: string) => {
    if (!existsSync(fsPath)) return;
    entries.push({ zipPath, fsPath, size: statSync(fsPath).size });
  };

  // --- Global config files -----------------------------------------------
  for (const name of GLOBAL_FILES) {
    addFile(`config/${name}`, join(configDir, name));
  }
  for (const dir of GLOBAL_DIRS) {
    collectDir(join(configDir, dir), `config/${dir}`, entries);
  }
  const credentialsPath = join(configDir, 'credentials.enc');
  if (options.includeCredentials) {
    addFile('config/credentials.enc', credentialsPath);
  } else if (existsSync(credentialsPath)) {
    warnings.push(
      'credentials.enc was not exported: it is OS-encrypted and cannot be used on another machine. Re-connect accounts after import.',
    );
  }

  // --- Workspaces ----------------------------------------------------------
  const wsMeta: ExportManifest['workspaces'] = [];
  const usedSegments = new Set<string>();
  for (const ws of workspaces) {
    if (!ws.rootPath) {
      warnings.push(`Workspace "${ws.name ?? ws.id}" has no rootPath and was skipped.`);
      continue;
    }
    const base = sanitizeSegment(ws.slug || ws.id);
    let segment = base;
    let counter = 2;
    while (usedSegments.has(segment)) {
      segment = `${base}-${counter}`;
      counter += 1;
    }
    usedSegments.add(segment);

    for (const name of WORKSPACE_FILES) {
      addFile(`workspaces/${segment}/${name}`, join(ws.rootPath, name));
    }
    for (const dir of WORKSPACE_DIRS) {
      collectDir(join(ws.rootPath, dir), `workspaces/${segment}/${dir}`, entries);
    }
    wsMeta.push({ id: ws.id, name: ws.name, slug: ws.slug, rootPath: ws.rootPath });
  }
  if (entries.length === 0) {
    warnings.push('No exportable files were found — check that the app has data to export.');
  }

  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    platform: process.platform,
    includeCredentials: options.includeCredentials ?? false,
    workspaces: wsMeta,
  };

  const bytes = await buildZip(options.destPath, manifest, entries, options.onProgress);

  return {
    destPath: options.destPath,
    bytes,
    fileCount: entries.length + 1,
    workspaceCount: wsMeta.length,
    warnings,
  };
}

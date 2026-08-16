/**
 * Import Resources Handler (AI tool)
 *
 * Imports a portable resource archive (created by `export_resources` or the
 * UI export) into the current workspace — one-click transfer of MCP sources,
 * API sources, skills, and automations between workspaces.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import { RESOURCE_BUNDLE_FILE_MARKER } from './resource-bundle-format.ts';

export interface ImportResourcesArgs {
  /** Absolute path of the archive file to import (e.g. /path/to/my-sources.craft-resources.json). */
  filePath: string;
  /** Conflict handling: 'skip' (default) keeps existing resources, 'overwrite' replaces them. */
  mode?: 'skip' | 'overwrite';
}

/** Minimal structural check shared by every importer. */
function unwrapBundle(text: string): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON');
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as Record<string, unknown>).format !== RESOURCE_BUNDLE_FILE_MARKER
  ) {
    throw new Error(`Not a Craft resource bundle file (missing format marker "${RESOURCE_BUNDLE_FILE_MARKER}")`);
  }
  const envelope = raw as { version?: number; bundle?: unknown };
  if (envelope.version !== 1) {
    throw new Error(`Unsupported bundle file version: ${String(envelope.version)}`);
  }
  if (envelope.bundle === undefined || envelope.bundle === null) {
    throw new Error('Bundle file has no bundle payload');
  }
  return envelope.bundle;
}

/**
 * Handle the import_resources tool call.
 *
 * Uses the context's `importResources` capability (Claude + Codex contexts)
 * so staging, conflict handling, and credential cleanup stay consistent with
 * the UI import path.
 */
export async function handleImportResources(
  ctx: SessionToolContext,
  args: ImportResourcesArgs,
): Promise<ToolResult> {
  const { filePath } = args;
  if (!filePath) {
    return errorResponse('Missing required parameter: filePath (absolute path of the archive file to import)');
  }

  if (!ctx.importResources) {
    return errorResponse('Resource import is not available in this environment.');
  }

  try {
    const bundle = unwrapBundle(ctx.fs.readFile(filePath));
    const mode = args.mode ?? 'skip';
    const result = await ctx.importResources(bundle, mode);

    const summarize = (label: string, bucket: { imported: string[]; skipped: string[]; failed: Array<{ id: string; error: string }> }) => {
      const parts = [`${label}: ${bucket.imported.length} imported`];
      if (bucket.skipped.length > 0) parts.push(`${bucket.skipped.length} skipped (already exists)`);
      if (bucket.failed.length > 0) {
        parts.push(`${bucket.failed.length} failed`);
        for (const f of bucket.failed) parts.push(`  ✗ ${f.id}: ${f.error}`);
      }
      return parts.join(', ');
    };

    const lines = [
      `✓ Imported resource archive from ${filePath} (mode=${mode})`,
      `  ${summarize('sources', result.sources)}`,
      `  ${summarize('skills', result.skills)}`,
      `  ${summarize('automations', result.automations)}`,
    ];
    const anyImported = result.sources.imported.length + result.skills.imported.length + result.automations.imported.length;
    if (anyImported > 0) {
      lines.push('', 'Imported resources are active for new sessions. Run source_test on imported sources that need credentials.');
    }
    return successResponse(lines.join('\n'));
  } catch (err) {
    return errorResponse(`Failed to import resources: ${err instanceof Error ? err.message : String(err)}`);
  }
}

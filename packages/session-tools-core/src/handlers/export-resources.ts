/**
 * Export Resources Handler (AI tool)
 *
 * Packages workspace resources (MCP sources, API sources, skills,
 * automations) into a portable JSON archive file that can later be imported
 * into another workspace with `import_resources` (or via the UI's one-click
 * import).
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import { RESOURCE_BUNDLE_FILE_MARKER } from './resource-bundle-format.ts';

export interface ExportResourcesArgs {
  /** Absolute path of the archive file to write (e.g. /path/to/my-sources.craft-resources.json). */
  filePath: string;
  /** Source slugs to include, or 'all' (default) for every MCP/API source. */
  sources?: string[] | 'all';
  /** Skill slugs to include, or 'all' for every skill. */
  skills?: string[] | 'all';
  /** Include automations: true (= 'all'), specific IDs, or omit. */
  automations?: boolean | string[] | 'all';
}

/**
 * Handle the export_resources tool call.
 *
 * Uses the context's `exportResources` capability (provided by both the
 * Claude and Codex contexts) so sanitization and file collection logic stays
 * in one place. Falls back to direct on-disk copying when the capability is
 * unavailable.
 */
export async function handleExportResources(
  ctx: SessionToolContext,
  args: ExportResourcesArgs,
): Promise<ToolResult> {
  const { filePath } = args;
  if (!filePath) {
    return errorResponse('Missing required parameter: filePath (absolute path of the archive file to write)');
  }

  if (!ctx.exportResources) {
    return errorResponse('Resource export is not available in this environment.');
  }

  try {
    const { bundle, warnings } = ctx.exportResources({
      sources: args.sources ?? 'all',
      skills: args.skills ?? 'all',
      automations: args.automations,
    });

    // Same envelope as the manual UI export so both flows are interoperable.
    const envelope = JSON.stringify(
      { format: RESOURCE_BUNDLE_FILE_MARKER, version: 1, bundle },
      null,
      2,
    );
    ctx.fs.writeFile(filePath, envelope);

    const resources =
      (bundle as { resources?: { sources?: unknown[]; skills?: unknown[]; automations?: unknown[] } }).resources ?? {};
    const lines = [
      `✓ Exported resource archive to ${filePath}`,
      `  sources: ${resources.sources?.length ?? 0}`,
      `  skills: ${resources.skills?.length ?? 0}`,
      `  automations: ${resources.automations?.length ?? 0}`,
    ];
    if (warnings.length > 0) {
      lines.push('Warnings:', ...warnings.map((w) => `  - ${w}`));
    }
    lines.push(
      '',
      'The archive can be imported into another workspace with the import_resources tool',
      'or via Settings → Sources → Import bundle.',
    );
    return successResponse(lines.join('\n'));
  } catch (err) {
    return errorResponse(`Failed to export resources: ${err instanceof Error ? err.message : String(err)}`);
  }
}

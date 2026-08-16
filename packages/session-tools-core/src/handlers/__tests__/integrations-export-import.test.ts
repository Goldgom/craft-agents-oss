/**
 * Export/import resources handler tests (AI tools).
 */

import { describe, expect, it } from 'bun:test';
import type { SessionToolContext } from '../../context.ts';
import type { ToolResult } from '../../types.ts';
import { handleExportResources } from '../export-resources.ts';
import { handleImportResources } from '../import-resources.ts';

function makeFakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  return {
    exists: (p: string) => files.has(p),
    readFile: (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    readFileBuffer: (p: string) => Buffer.from(files.get(p) ?? '', 'utf-8'),
    writeFile: (p: string, content: string) => files.set(p, content),
    isDirectory: () => false,
    readdir: () => [],
    stat: (p: string) => ({ size: files.get(p)?.length ?? 0, isDirectory: () => false }),
    snapshot: () => Object.fromEntries(files),
  };
}

function makeFakeContext(overrides: Partial<SessionToolContext> = {}): SessionToolContext {
  return {
    sessionId: 'test-session',
    workspacePath: '/ws/test',
    get sourcesPath() { return '/ws/test/sources'; },
    get skillsPath() { return '/ws/test/skills'; },
    plansFolderPath: '/ws/test/plans',
    callbacks: { onPlanSubmitted: () => {}, onAuthRequest: () => {} },
    fs: makeFakeFs(),
    loadSourceConfig: () => null,
    ...overrides,
  } as SessionToolContext;
}

const MARKER = 'craft-resource-bundle';

function textOf(result: ToolResult): string {
  const first = result.content[0];
  return first && first.type === 'text' ? first.text : JSON.stringify(result.content);
}

describe('handleExportResources', () => {
  it('writes the resource archive envelope and reports counts', async () => {
    const fs = makeFakeFs();
    const ctx = makeFakeContext({
      fs,
      exportResources: () => ({
        bundle: {
          version: 1,
          exportedAt: 1,
          resources: { sources: [{ slug: 'a' }, { slug: 'b' }], skills: [], automations: [] },
        },
        warnings: ['stripped something'],
      }),
    });

    const result = await handleExportResources(ctx, { filePath: '/out/bundle.json', sources: 'all' });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('sources: 2');
    expect(textOf(result)).toContain('stripped something');

    const written = fs.snapshot()['/out/bundle.json']!;
    expect(written).toContain(MARKER);
    const envelope = JSON.parse(written);
    expect(envelope.format).toBe(MARKER);
    expect(envelope.bundle.resources.sources).toHaveLength(2);
  });

  it('errors when the capability is unavailable or filePath missing', async () => {
    const ctx = makeFakeContext(); // no exportResources
    const missingPath = await handleExportResources(ctx, {} as never);
    expect(missingPath.isError).toBe(true);

    const noCapability = await handleExportResources(ctx, { filePath: '/x.json' });
    expect(noCapability.isError).toBe(true);
    expect(textOf(noCapability)).toContain('not available');
  });
});

describe('handleImportResources', () => {
  it('imports an archive file and reports bucket summaries', async () => {
    const fs = makeFakeFs({
      '/in/bundle.json': JSON.stringify({
        format: MARKER,
        version: 1,
        bundle: { version: 1, exportedAt: 1, resources: {} },
      }),
    });
    const ctx = makeFakeContext({
      fs,
      importResources: async (_bundle: unknown, _mode: 'skip' | 'overwrite') => ({
        sources: { imported: ['mcp-a'], skipped: ['api-b'], failed: [], warnings: [] },
        skills: { imported: [], skipped: [], failed: [], warnings: [] },
        automations: { imported: [], skipped: [], failed: [], warnings: [] },
      }),
    });

    const result = await handleImportResources(ctx, { filePath: '/in/bundle.json', mode: 'skip' });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('1 imported');
    expect(textOf(result)).toContain('1 skipped');
  });

  it('rejects files that are not resource bundles', async () => {
    const fs = makeFakeFs({ '/in/bad.json': '{"nope": true}' });
    const ctx = makeFakeContext({ fs, importResources: async () => ({ sources: { imported: [], skipped: [], failed: [], warnings: [] }, skills: { imported: [], skipped: [], failed: [], warnings: [] }, automations: { imported: [], skipped: [], failed: [], warnings: [] } }) });
    const result = await handleImportResources(ctx, { filePath: '/in/bad.json' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('format marker');
  });

  it('errors when the capability is unavailable', async () => {
    const ctx = makeFakeContext();
    const result = await handleImportResources(ctx, { filePath: '/x.json' });
    expect(result.isError).toBe(true);
  });
});

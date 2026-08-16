import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RESOURCE_BUNDLE_FILE_MARKER,
  RESOURCE_BUNDLE_FILE_EXTENSION,
  stringifyResourceBundle,
  parseResourceBundle,
  writeResourceBundleFile,
  readResourceBundleFile,
} from '../resource-file.ts';
import { exportResources } from '../resource-bundle.ts';
import type { ResourceBundle } from '../types.ts';

function makeBundle(): ResourceBundle {
  return {
    version: 1,
    exportedAt: Date.now(),
    sourceWorkspace: 'Test Workspace',
    resources: {
      sources: [],
      skills: [],
      automations: [],
    },
  };
}

describe('resource bundle file persistence', () => {
  it('round-trips a bundle through a JSON archive file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-bundle-'));
    try {
      const bundle = makeBundle();
      const filePath = join(dir, `test${RESOURCE_BUNDLE_FILE_EXTENSION}`);

      writeResourceBundleFile(filePath, bundle);
      const text = readFileSync(filePath, 'utf-8');
      expect(text).toContain(RESOURCE_BUNDLE_FILE_MARKER);

      const parsed = readResourceBundleFile(filePath);
      expect(parsed.version).toBe(1);
      expect(parsed.sourceWorkspace).toBe('Test Workspace');
      expect(parsed.resources).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects non-bundle JSON with a clear error', () => {
    expect(() => parseResourceBundle('{"hello": 1}')).toThrow(/format marker/);
    expect(() => parseResourceBundle('not json')).toThrow(/Not valid JSON/);
    expect(() => parseResourceBundle(JSON.stringify({ format: RESOURCE_BUNDLE_FILE_MARKER, version: 2, bundle: {} }))).toThrow(/version/);
  });

  it('rejects bundles with invalid resources', () => {
    const envelope = JSON.stringify({
      format: RESOURCE_BUNDLE_FILE_MARKER,
      version: 1,
      bundle: { version: 1, exportedAt: 1, resources: { sources: [{ slug: 'x' }] } },
    });
    expect(() => parseResourceBundle(envelope)).toThrow(/Invalid resource bundle/);
  });

  it('rejects missing files', () => {
    expect(() => readResourceBundleFile(join(tmpdir(), 'does-not-exist.json'))).toThrow(/not found/);
  });

  it('archives a real exportResources result and re-parses it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-bundle-'));
    try {
      const result = exportResources(dir, { sources: 'all', skills: 'all', automations: true });
      const text = stringifyResourceBundle(result.bundle);
      const parsed = parseResourceBundle(text);
      expect(parsed.resources).toEqual(result.bundle.resources);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

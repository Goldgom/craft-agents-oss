/**
 * Tests for workspace preference prompts (全局提示词):
 * normalization, enabled filtering, system-prompt injection.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  normalizeWorkspacePrompt,
  loadWorkspacePrompts,
  loadEnabledWorkspacePrompts,
  formatWorkspacePromptsForPrompt,
  WORKSPACE_PROMPT_LIMITS,
  saveWorkspaceConfig,
} from '../src/workspaces';
import type { WorkspacePrompt } from '../src/workspaces';
import { getSystemPrompt } from '../src/prompts/system';

const tempDirs: string[] = [];

function makeWorkspaceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws-prompts-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makePrompt(overrides: Partial<WorkspacePrompt> = {}): WorkspacePrompt {
  return {
    id: 'p1',
    title: 'Code style',
    content: 'Always use strict TypeScript.',
    enabled: true,
    source: 'manual',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('normalizeWorkspacePrompt', () => {
  test('returns null for malformed values', () => {
    expect(normalizeWorkspacePrompt(null)).toBeNull();
    expect(normalizeWorkspacePrompt('nope')).toBeNull();
    expect(normalizeWorkspacePrompt({})).toBeNull();
    expect(normalizeWorkspacePrompt({ id: 'x' })).toBeNull();
  });

  test('applies defaults and sanitizes control characters', () => {
    const result = normalizeWorkspacePrompt({
      id: 'x',
      title: 'T\u0000it\u0007le',
      content: 'Body\u001f text',
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Title');
    expect(result!.content).toBe('Body text');
    expect(result!.enabled).toBe(true);
    expect(result!.source).toBe('manual');
  });

  test('preserves explicit fields', () => {
    const result = normalizeWorkspacePrompt(
      makePrompt({ enabled: false, source: 'ai', createdAt: 42, updatedAt: 43 }),
    );
    expect(result!.enabled).toBe(false);
    expect(result!.source).toBe('ai');
    expect(result!.createdAt).toBe(42);
    expect(result!.updatedAt).toBe(43);
  });
});

describe('loadWorkspacePrompts / loadEnabledWorkspacePrompts', () => {
  test('returns [] when no config or no prompts', () => {
    const dir = makeWorkspaceDir();
    expect(loadWorkspacePrompts(dir)).toEqual([]);
    expect(loadEnabledWorkspacePrompts(dir)).toEqual([]);
  });

  test('round-trips through saveWorkspaceConfig and filters disabled', () => {
    const dir = makeWorkspaceDir();
    saveWorkspaceConfig(dir, {
      id: 'ws1',
      name: 'Test',
      createdAt: 1,
      updatedAt: 1,
      prompts: [
        makePrompt({ id: 'a', updatedAt: 100 }),
        makePrompt({ id: 'b', enabled: false, updatedAt: 200 }),
        makePrompt({ id: 'c', updatedAt: 300 }),
      ],
    });

    const all = loadWorkspacePrompts(dir);
    expect(all.map(p => p.id)).toEqual(['a', 'b', 'c']);

    // Enabled only, newest first
    const enabled = loadEnabledWorkspacePrompts(dir);
    expect(enabled.map(p => p.id)).toEqual(['c', 'a']);
  });

  test('skips malformed persisted entries', () => {
    const dir = makeWorkspaceDir();
    saveWorkspaceConfig(dir, {
      id: 'ws1',
      name: 'Test',
      createdAt: 1,
      updatedAt: 1,
      prompts: [makePrompt(), { id: 'broken' }],
    });
    const all = loadWorkspacePrompts(dir);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('p1');
  });
});

describe('formatWorkspacePromptsForPrompt', () => {
  test('returns empty string when nothing enabled', () => {
    expect(formatWorkspacePromptsForPrompt([])).toBe('');
    expect(formatWorkspacePromptsForPrompt([makePrompt({ enabled: false })])).toBe('');
    expect(formatWorkspacePromptsForPrompt([makePrompt({ content: '   ' })])).toBe('');
  });

  test('renders enabled prompts with wrapper tags', () => {
    const out = formatWorkspacePromptsForPrompt([
      makePrompt({ id: 'a', title: 'Style', content: 'Always use tabs.' }),
      makePrompt({ id: 'b', title: 'Terms', content: 'Call it "module".', enabled: false }),
    ]);
    expect(out).toContain('## Workspace preferences');
    expect(out).toContain('<workspace_preference id="a" title="Style">');
    expect(out).toContain('Always use tabs.');
    expect(out).not.toContain('Call it "module"');
  });
});

describe('getSystemPrompt injection', () => {
  test('injects enabled workspace prompts and omits disabled ones', () => {
    const dir = makeWorkspaceDir();
    saveWorkspaceConfig(dir, {
      id: 'ws1',
      name: 'Test',
      createdAt: 1,
      updatedAt: 1,
      prompts: [
        makePrompt({ id: 'on', title: 'Enabled prefs', content: 'Follow the house style.' }),
        makePrompt({ id: 'off', title: 'Disabled prefs', content: 'This must not appear.', enabled: false }),
      ],
    });

    const prompt = getSystemPrompt(undefined, undefined, dir);
    expect(prompt).toContain('## Workspace preferences');
    expect(prompt).toContain('<workspace_preference id="on" title="Enabled prefs">');
    expect(prompt).toContain('Follow the house style.');
    expect(prompt).not.toContain('This must not appear.');
  });

  test('omits block when workspace has no prompts', () => {
    const dir = makeWorkspaceDir();
    saveWorkspaceConfig(dir, { id: 'ws1', name: 'Test', createdAt: 1, updatedAt: 1 });
    const prompt = getSystemPrompt(undefined, undefined, dir);
    expect(prompt).not.toContain('## Workspace preferences');
  });

  test('limits are sane', () => {
    expect(WORKSPACE_PROMPT_LIMITS.maxPrompts).toBeGreaterThan(0);
    expect(WORKSPACE_PROMPT_LIMITS.contentMax).toBeGreaterThan(1000);
  });
});

/**
 * Workspace preference prompts (全局提示词).
 *
 * Each workspace can carry a list of preference prompts in its config.json
 * (`prompts[]`). Enabled entries are injected into the system prompt of every
 * conversation in the workspace via `formatWorkspacePromptsForPrompt()`.
 */

import { loadWorkspaceConfig } from './storage';
import type { WorkspacePrompt } from './types';

/** Hard limits for prompt CRUD (server enforces, UI mirrors). */
export const WORKSPACE_PROMPT_LIMITS = {
  maxPrompts: 20,
  titleMax: 100,
  contentMax: 20_000,
  descriptionMax: 2_000,
} as const;

/** Strip control chars that could break prompt formatting. */
function sanitizePromptText(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/**
 * Normalize a raw config value into a valid WorkspacePrompt, or null when it
 * is malformed. Used by the load path so a bad persisted entry never crashes
 * prompt building.
 */
export function normalizeWorkspacePrompt(value: unknown): WorkspacePrompt | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0) return null;
  if (typeof v.title !== 'string' || typeof v.content !== 'string') return null;
  return {
    id: v.id,
    title: sanitizePromptText(v.title).trim(),
    content: sanitizePromptText(v.content).trim(),
    enabled: v.enabled !== false,
    source: v.source === 'ai' ? 'ai' : 'manual',
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : Date.now(),
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : Date.now(),
  };
}

/** Load all prompts from a workspace's config.json (normalized, unsorted). */
export function loadWorkspacePrompts(rootPath: string): WorkspacePrompt[] {
  const config = loadWorkspaceConfig(rootPath);
  if (!config || !Array.isArray(config.prompts)) return [];
  return config.prompts
    .map(normalizeWorkspacePrompt)
    .filter((p): p is WorkspacePrompt => p !== null);
}

/** Load only the enabled prompts, newest first. */
export function loadEnabledWorkspacePrompts(rootPath: string): WorkspacePrompt[] {
  return loadWorkspacePrompts(rootPath)
    .filter((p) => p.enabled)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Render enabled workspace prompts as the system-prompt block injected into
 * every conversation. Returns '' when nothing is enabled.
 */
export function formatWorkspacePromptsForPrompt(prompts: WorkspacePrompt[]): string {
  const enabled = prompts.filter((p) => p.enabled && p.content.trim().length > 0);
  if (enabled.length === 0) return '';

  const entries = enabled
    .map(
      (p) =>
        `<workspace_preference id="${p.id}" title="${p.title}">\n${sanitizePromptText(p.content)}\n</workspace_preference>`,
    )
    .join('\n\n');

  return `\n## Workspace preferences\nThese workspace-wide preferences are set by the user and apply to every conversation in this workspace. Follow them as standing instructions.\n\n${entries}`;
}

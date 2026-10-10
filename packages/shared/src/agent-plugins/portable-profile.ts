import { createHash } from 'node:crypto';
import { z } from 'zod';
import { loadPreferences, savePreferences, updatePreferences, type UserPreferences } from '../config/preferences.ts';
import { getDefaultThinkingLevel, setDefaultThinkingLevel } from '../config/storage.ts';
import { loadWorkspaceConfig, saveWorkspaceConfig } from '../workspaces/storage.ts';
import { loadWorkspacePrompts, WORKSPACE_PROMPT_LIMITS } from '../workspaces/prompts.ts';
import type { WorkspacePrompt } from '../workspaces/types.ts';

const text = z.string().max(20_000);
const capabilities = z.object({ browserTools: z.boolean().optional(), webSearch: z.boolean().optional(),
  structuredData: z.boolean().optional(), subagents: z.boolean().optional(), documentTools: z.boolean().optional(), themeDesign: z.boolean().optional() }).strict();
const preferenceSchema = z.object({ name: text.optional(), timezone: text.optional(), notes: text.optional(),
  location: z.object({ city: text.optional(), region: text.optional(), country: text.optional() }).strict().optional(),
  includeCoAuthoredBy: z.boolean().optional(),
  systemPrompt: z.object({ editableInstructions: text.optional(), capabilities: capabilities.optional() }).strict().optional(),
}).strict();
export const portableAgentProfileSchema = z.object({
  format: z.literal('tokenbird-agent-profile'), version: z.literal(1),
  preferences: preferenceSchema,
  defaultThinkingLevel: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  workspacePrompts: z.array(z.object({ id: z.string().min(1).max(100), title: z.string().min(1).max(WORKSPACE_PROMPT_LIMITS.titleMax),
    content: z.string().max(WORKSPACE_PROMPT_LIMITS.contentMax), enabled: z.boolean() }).strict()).max(WORKSPACE_PROMPT_LIMITS.maxPrompts).optional(),
}).strict();
export type PortableAgentProfile = z.infer<typeof portableAgentProfileSchema>;

/** Allowlist excludes provider keys, OAuth grants, proxy credentials and machine paths. */
export function exportPortableAgentProfile(workspaceRoot?: string): PortableAgentProfile {
  const current = loadPreferences();
  const preferences: PortableAgentProfile['preferences'] = {};
  for (const key of ['name', 'timezone', 'notes', 'location', 'includeCoAuthoredBy', 'systemPrompt'] as const) {
    if (current[key] !== undefined) Object.assign(preferences, { [key]: current[key] });
  }
  return portableAgentProfileSchema.parse({ format: 'tokenbird-agent-profile', version: 1, preferences,
    defaultThinkingLevel: getDefaultThinkingLevel(),
    workspacePrompts: workspaceRoot ? loadWorkspacePrompts(workspaceRoot).map(({ id, title, content, enabled }) => ({ id, title, content, enabled })) : undefined });
}

/** Native AGENTS.md / CLAUDE.md / SOUL.md instructions can be imported as workspace preferences. */
export function parsePortableAgentProfile(input: unknown): PortableAgentProfile {
  if (typeof input !== 'string') return portableAgentProfileSchema.parse(input);
  if (Buffer.byteLength(input) > 512 * 1024) throw new Error('Agent preference package is too large');
  const value = input.trim();
  if (!value) throw new Error('Agent preferences are empty');
  if (value.startsWith('{') || value.startsWith('[')) return portableAgentProfileSchema.parse(JSON.parse(value));
  if (value.length > WORKSPACE_PROMPT_LIMITS.contentMax) throw new Error('Agent instructions are too long');
  const id = `import-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
  return { format: 'tokenbird-agent-profile', version: 1, preferences: {}, workspacePrompts: [{ id, title: 'Imported agent instructions', content: value, enabled: true }] };
}

export function importPortableAgentProfile(input: unknown, workspaceRoot?: string): PortableAgentProfile {
  const profile = parsePortableAgentProfile(input);
  if (profile.workspacePrompts?.length && !workspaceRoot) throw new Error('Select a workspace to import agent instructions');
  const beforePreferences = loadPreferences();
  const beforeThinking = getDefaultThinkingLevel();
  const workspace = workspaceRoot ? loadWorkspaceConfig(workspaceRoot) : null;
  if (workspaceRoot && !workspace) throw new Error('Workspace configuration is unavailable');
  let prompts: WorkspacePrompt[] | undefined;
  if (profile.workspacePrompts && workspaceRoot) {
    const byId = new Map(loadWorkspacePrompts(workspaceRoot).map(prompt => [prompt.id, prompt]));
    for (const prompt of profile.workspacePrompts) {
      byId.set(prompt.id, { ...byId.get(prompt.id), ...prompt, source: 'manual', createdAt: byId.get(prompt.id)?.createdAt ?? Date.now(), updatedAt: Date.now() });
    }
    prompts = [...byId.values()];
    if (prompts.length > WORKSPACE_PROMPT_LIMITS.maxPrompts) throw new Error('Too many workspace preference prompts');
  }
  // Validate everything before changing any of the existing stores.
  try {
    if (profile.defaultThinkingLevel && !setDefaultThinkingLevel(profile.defaultThinkingLevel)) throw new Error('Could not save thinking preferences');
    updatePreferences(profile.preferences as Partial<UserPreferences>);
    if (workspace && workspaceRoot && prompts) saveWorkspaceConfig(workspaceRoot, { ...workspace, prompts });
  } catch (error) {
    savePreferences(beforePreferences); setDefaultThinkingLevel(beforeThinking);
    if (workspace && workspaceRoot) saveWorkspaceConfig(workspaceRoot, workspace);
    throw error;
  }
  return exportPortableAgentProfile(workspaceRoot);
}

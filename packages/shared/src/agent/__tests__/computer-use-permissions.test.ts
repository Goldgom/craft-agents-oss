import { describe, expect, it } from 'bun:test';
import { shouldAllowToolInMode } from '../mode-manager.ts';
import { shouldPromptInAskMode } from '../core/pre-tool-use.ts';

const manager = { isCommandWhitelisted: () => false } as any;
const context = { workspaceRootPath: process.cwd() } as any;

describe('Windows desktop permissions', () => {
  it('allows observation in Explore and blocks every input action', () => {
    for (const name of ['computer_use', 'mcp__session__computer_use']) {
      for (const action of ['status', 'screenshot', 'snapshot', 'windows', 'position', 'wait']) {
        expect(shouldAllowToolInMode(name, { action }, 'safe').allowed).toBe(true);
        expect(shouldPromptInAskMode(name, { action }, manager, context)).toBeNull();
      }
      for (const action of ['focus', 'move', 'click', 'drag', 'scroll', 'type', 'key', 'unknown']) {
        expect(shouldAllowToolInMode(name, { action }, 'safe').allowed).toBe(false);
        expect(shouldPromptInAskMode(name, { action }, manager, context)?.promptType).toBe('mcp_mutation');
        expect(shouldAllowToolInMode(name, { action }, 'allow-all').allowed).toBe(true);
      }
    }
  });

  it('retains explicit session approval in Ask', () => {
    expect(shouldPromptInAskMode('mcp__session__computer_use', { action: 'type' },
      { isCommandWhitelisted: () => true } as any, context)).toBeNull();
  });
});

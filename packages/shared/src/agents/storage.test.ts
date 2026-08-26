import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listAgents, loadClaudeSubagents, saveAgentsConfig } from './storage.ts'

describe('workspace agents storage', () => {
  it('always exposes compact and merges a workspace override', async () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-agents-'))
    try {
      await saveAgentsConfig(root, {
        version: 1,
        agents: [{
          id: 'compact',
          name: 'Shorten context',
          description: 'Workspace compaction policy',
          prompt: 'Keep decisions and unresolved work.',
          builtin: true,
        }],
      })
      const compact = (await listAgents(root)).find(agent => agent.id === 'compact')
      expect(compact?.builtin).toBe(true)
      expect(compact?.name).toBe('Shorten context')
      expect((await loadClaudeSubagents(root)).compact).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a user agent that claims the built-in marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-agents-'))
    try {
      await expect(saveAgentsConfig(root, {
        version: 1,
        agents: [{ id: 'review', name: 'Review', description: 'Review', prompt: 'Review', builtin: true }],
      })).rejects.toThrow('Only the built-in')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

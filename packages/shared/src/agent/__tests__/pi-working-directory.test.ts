import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PiAgent } from '../pi-agent'
import type { BackendConfig } from '../backend/types'

function createAgent(workingDirectory?: string) {
  return new PiAgent({
    provider: 'pi',
    workspace: { id: 'cwd-test', name: 'Test', rootPath: join(homedir(), 'test-workspace') },
    session: { id: 'session-test', workingDirectory, sdkCwd: join(homedir(), 'old-sdk-storage') },
    isHeadless: true,
  } as BackendConfig)
}

describe('Pi working directory', () => {
  it('uses the advertised session root for default tool execution', () => {
    const agent = createAgent()
    try {
      const harness = agent as any
      const expected = join(homedir(), 'test-workspace', 'sessions', 'session-test')
      expect(harness.resolvedCwd()).toBe(expected)
      expect(harness.promptBuilder.getWorkingDirectoryContext()).toContain(`<working_directory>${expected}</working_directory>`)
    } finally { agent.destroy() }
  })

  it('keeps actual tool cwd separate from SDK storage and reports pending changes', () => {
    const first = join(homedir(), 'project-a')
    const second = join(homedir(), 'project-b')
    const agent = createAgent(first)
    try {
      const harness = agent as any
      expect(harness.promptBuilder.getWorkingDirectoryContext()).not.toContain('different directory')
      agent.updateWorkingDirectory(second)
      expect(harness.resolvedCwd()).toBe(second)
      expect(harness.promptBuilder.getWorkingDirectoryContext()).toContain(`different directory (${first})`)
      harness.promptBuilder.setExecutionWorkingDirectory(second)
      expect(harness.promptBuilder.getWorkingDirectoryContext()).not.toContain('different directory')
    } finally { agent.destroy() }
  })

  it('expands legacy Windows home paths before spawning', () => {
    const agent = createAgent('~\\project')
    try { expect((agent as any).resolvedCwd()).toBe(join(homedir(), 'project')) }
    finally { agent.destroy() }
  })

  it('reinitializes idle tools after a directory change without clearing history', async () => {
    const first = join(homedir(), 'project-a')
    const second = join(homedir(), 'project-b')
    const agent = createAgent(first)
    const harness = agent as any
    try {
      harness.subprocess = {}
      harness.subprocessWorkingDirectory = first
      harness.subprocessReady = Promise.resolve()
      harness.piSessionId = 'existing-history'
      let stopped = 0
      let spawned = 0
      harness.killSubprocess = () => { stopped++; harness.subprocess = null; harness.subprocessReady = null }
      harness.spawnSubprocess = async () => { spawned++; expect(harness.resolvedCwd()).toBe(second) }
      agent.updateWorkingDirectory(second)
      await harness.ensureSubprocess()
      expect(stopped).toBe(1)
      expect(spawned).toBe(1)
      expect(harness.piSessionId).toBe('existing-history')
    } finally { harness.subprocess = null; agent.destroy() }
  })
})
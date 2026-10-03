import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { SuperAgentConfig, SuperAgentEnvironment, SuperAgentSessionPolicy } from '@craft-agent/shared/super-agent'
import { sandboxArguments, SuperAgentEnvironments } from './SuperAgentEnvironments'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'tokenbird-super-env-')) })
afterEach(async () => {
  const child = relative(tmpdir(), root)
  if (isAbsolute(child) || child.startsWith(`..${sep}`) || !child.startsWith('tokenbird-super-env-')) throw new Error('Invalid test cleanup directory')
  await rm(root, { recursive: true, force: true })
})

function environment(): SuperAgentEnvironment {
  return { kind: 'sandbox', workingDirectory: root, permissionMode: 'ask', permissions: { readFiles: true, writeFiles: false, runPrograms: true, browser: false }, sandbox: { runtime: 'docker', image: 'node:22-bookworm-slim' } }
}

function policy(): SuperAgentSessionPolicy {
  return { nodeId: 'worker', role: 'worker', rootPath: root, readFiles: true, writeFiles: false, runPrograms: true, browser: false, allowSources: [], allowSubagents: false }
}

const runtimePath = process.platform === 'win32' ? 'C:\\Program Files\\Docker\\docker.exe' : '/usr/bin/docker'

describe('Super Agent execution environments', () => {
  it('polling verifies availability without launching containers or preparing images', async () => {
    const calls: string[][] = []
    const environments = new SuperAgentEnvironments({ findRuntime: async () => runtimePath, run: async (_runtime, args) => { calls.push(args); return '28.0.0' } })
    expect((await environments.resolve('workspace', environment())).status.isolation).toBe('container')
    expect((await environments.resolve('workspace', environment())).status.available).toBe(true)
    expect(calls.map(args => args[0])).toEqual(['info'])
    await environments.cleanup()
  })

  it('daemon failures produce unavailable state without falling back to host execution', async () => {
    const environments = new SuperAgentEnvironments({ findRuntime: async () => runtimePath, run: async () => { throw new Error('daemon is not running') } })
    const resolved = await environments.resolve('workspace', environment())
    expect(resolved.status).toMatchObject({ available: false, isolation: 'unavailable' })
    expect(resolved.status.detail).toContain('daemon is not running')
    await expect(environments.prepareSession('workspace', environment(), policy())).rejects.toThrow('daemon is not running')
    await environments.cleanup()
  })

  it('container programs see only the selected readonly mount and bounded isolated resources', () => {
    const args = sandboxArguments('tokenbird-super-1234', root, environment())
    expect(args).toContain('--read-only')
    expect(args).toContain('--cap-drop=ALL')
    expect(args).toContain('--security-opt=no-new-privileges')
    expect(args).toContain('--network=none')
    expect(args).toContain('--pids-limit=128')
    expect(args).toContain('--memory=1g')
    expect(args).toContain(`type=bind,source=${root},target=/workspace,readonly`)
    expect(args).not.toContain('--privileged')
    expect(args).not.toContain('--env')
    expect(args.filter(arg => arg === '--mount')).toHaveLength(1)
    const denied = environment(); denied.permissions.readFiles = false
    expect(() => sandboxArguments('tokenbird-super-1234', root, denied)).toThrow('read permission')
    denied.sandbox!.image = '--privileged'
    expect(() => sandboxArguments('tokenbird-super-1234', root, denied)).toThrow('valid container image')
  })

  it('parallel preparation reuses one owned node container and shutdown removes it', async () => {
    const calls: string[][] = []
    const environments = new SuperAgentEnvironments({ findRuntime: async () => runtimePath, run: async (_runtime, args) => {
      calls.push(args)
      if (args[0] === 'inspect') throw new Error('No such container')
      return 'ready'
    } })
    const [first, second] = await Promise.all([environments.prepareSession('workspace', environment(), policy()), environments.prepareSession('workspace', environment(), policy())])
    expect(first).toEqual(second)
    expect(calls.filter(args => args[0] === 'run')).toHaveLength(1)
    expect(first?.containerId).toMatch(/^tokenbird-super-[a-f0-9]+$/)
    await environments.cleanup()
    expect(calls.filter(args => args[0] === 'rm')).toEqual([['rm', '--force', first!.containerId]])
    await expect(environments.prepareSession('workspace', environment(), policy())).rejects.toThrow('shutting down')
  })

  it('VM mode requires an identified VM server and its current workspace', async () => {
    const config = { ...environment(), kind: 'vm' as const, vm: { workspaceId: 'vm-workspace' } }
    const local = new SuperAgentEnvironments()
    expect((await local.resolve('vm-workspace', config)).status.available).toBe(false)
    const vm = new SuperAgentEnvironments({ isVmHost: true })
    expect((await vm.resolve('vm-workspace', config)).status).toMatchObject({ available: true, isolation: 'remote-vm' })
    expect((await vm.resolve('another-workspace', config)).status.available).toBe(false)
    await local.cleanup(); await vm.cleanup()
  })

  it('reports failed container termination instead of marking it stopped', async () => {
    const environments = new SuperAgentEnvironments({ findRuntime: async () => runtimePath, run: async (_runtime, args) => {
      if (args[0] === 'inspect') throw new Error('No such container')
      if (args[0] === 'rm') throw new Error('daemon connection timed out')
      return 'ready'
    } })
    await environments.prepareSession('workspace', environment(), policy())
    await expect(environments.cleanup()).rejects.toThrow('could not be stopped')
  })

  it('retires obsolete node containers and rejects their stale preparation', async () => {
    const removed: string[] = []
    const environments = new SuperAgentEnvironments({ findRuntime: async () => runtimePath, run: async (_runtime, args) => {
      if (args[0] === 'inspect') throw new Error('No such container')
      if (args[0] === 'rm') removed.push(args[2]!)
      return 'ready'
    } })
    const first = await environments.prepareSession('workspace', environment(), policy())
    const config: SuperAgentConfig = {
      version: 1, name: 'Test', avatar: '', idleInspectionMinutes: 15,
      environment: environment(), sourceSlugs: [], abilityProfiles: [], scripts: [],
      nodes: [
        { id: 'main', role: 'coordinator', name: 'Main', avatar: '', description: '', llmConnection: 'test', model: 'test', thinkingLevel: 'medium', maxCallsPerMinute: 6, intelligenceRating: 3, workPreferences: '', sourceSlugs: [], abilityProfileIds: [] },
        { id: 'new-worker', role: 'worker', name: 'Worker', avatar: '', description: '', llmConnection: 'test', model: 'test', thinkingLevel: 'medium', maxCallsPerMinute: 6, intelligenceRating: 3, workPreferences: '', sourceSlugs: [], abilityProfileIds: [] },
      ],
    }
    await environments.reconcile('workspace', config)
    expect(removed).toEqual([first!.containerId])
    await expect(environments.prepareSession('workspace', environment(), policy())).rejects.toThrow('settings changed')
    const next = await environments.prepareSession('workspace', environment(), { ...policy(), nodeId: 'new-worker' })
    expect(next!.containerId).not.toBe(first!.containerId)
    await environments.cleanup()
    expect(removed).toHaveLength(2)
  })
})

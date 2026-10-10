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
  it('checks image toolchains without mounting the project, pulling images or running host tools', async () => {
    const calls: string[][] = []
    const environments = new SuperAgentEnvironments({ findRuntime: async () => runtimePath, run: async (_runtime, args) => {
      calls.push(args)
      return args[0] === 'run' ? 'ok:sh\nok:git\nmissing:bun' : 'ready'
    } })
    const config = { environment: environment(), requirements: { programs: ['git', 'bun'], browser: true } } as SuperAgentConfig
    const readiness = await environments.checkReadiness('workspace', config, false)
    expect(readiness.ready).toBe(false)
    expect(readiness.checks.find(check => check.id === 'program:git')?.ok).toBe(true)
    expect(readiness.checks.find(check => check.id === 'program:bun')?.ok).toBe(false)
    expect(readiness.checks.find(check => check.id === 'browser')?.ok).toBe(false)
    const run = calls.find(args => args[0] === 'run')!
    expect(run).toContain('--pull=never')
    expect(run).toContain('--network=none')
    expect(run).not.toContain('--mount')
    expect(run).not.toContain('--privileged')
    expect(calls.some(args => args[0] === 'pull')).toBe(false)
    expect(calls.filter(args => args[0] === 'rm')).toHaveLength(1)
    await environments.cleanup()
  })

  it('reports folder, image and program-permission gaps before starting a model', async () => {
    const environments = new SuperAgentEnvironments({ findRuntime: async () => runtimePath, run: async (_runtime, args) => {
      if (args[0] === 'image') throw new Error('Image not present')
      return 'ready'
    } })
    const config = { environment: { ...environment(), kind: 'folder' }, requirements: { programs: ['python3'], browser: false } } as SuperAgentConfig
    expect((await environments.checkReadiness('workspace', config, true)).ready).toBe(false)
    config.environment = environment()
    const missing = await environments.checkReadiness('workspace', config, true)
    expect(missing.ready).toBe(false)
    expect(missing.checks.some(check => check.detail.includes('Image not present'))).toBe(true)
    config.environment.permissions.runPrograms = false
    expect((await environments.checkReadiness('workspace', config, true)).checks.some(check => check.id === 'programs' && !check.ok)).toBe(true)
    await environments.cleanup()
  })
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

  it('full control prepares coordinator sandboxes with writable project mounts', async () => {
    const calls: string[][] = []
    const environments = new SuperAgentEnvironments({ findRuntime: async () => runtimePath, run: async (_runtime, args) => {
      calls.push(args)
      if (args[0] === 'inspect') throw new Error('No such container')
      return 'ready'
    } })
    const full = { ...environment(), fullControl: true, permissions: { readFiles: false, writeFiles: false, runPrograms: false, browser: false } }
    const node = { id: 'main', role: 'coordinator' as const, name: 'Main', avatar: '', description: '', llmConnection: 'test', model: 'test', thinkingLevel: 'medium' as const, maxCallsPerMinute: 6, intelligenceRating: 3, workPreferences: '', sourceSlugs: [], abilityProfileIds: [] }
    await environments.reconcile('workspace', { version: 1, name: 'Test', avatar: '', idleInspectionMinutes: 15,
      environment: full, sourceSlugs: [], abilityProfiles: [], scripts: [], nodes: [node] })
    const executor = await environments.prepareSession('workspace', full, { ...policy(), nodeId: 'main', role: 'coordinator', fullControl: true, runPrograms: false })
    expect(executor).toBeDefined()
    const args = calls.find(args => args[0] === 'run')!
    expect(args).toContain(`type=bind,source=${root},target=/workspace`)
    expect(args).toContain('--network=none')
    expect(args).not.toContain('--privileged')
    await environments.cleanup()
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

  it('reset retires only the selected workspace containers', async () => {
    const removed: string[] = []
    const environments = new SuperAgentEnvironments({ findRuntime: async () => runtimePath, run: async (_runtime, args) => {
      if (args[0] === 'inspect') throw new Error('No such container')
      if (args[0] === 'rm') removed.push(args[2]!)
      return 'ready'
    } })
    try {
      const first = await environments.prepareSession('workspace', environment(), policy())
      const other = await environments.prepareSession('other', environment(), policy())
      await environments.reconcile('workspace', null)
      expect(removed).toEqual([first!.containerId])
      await expect(environments.prepareSession('workspace', environment(), policy())).rejects.toThrow('settings changed')
      expect(await environments.prepareSession('other', environment(), policy())).toEqual(other)
    } finally { await environments.cleanup() }
  })
})

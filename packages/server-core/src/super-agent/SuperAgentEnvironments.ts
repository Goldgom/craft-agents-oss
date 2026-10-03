import { createHash, randomUUID } from 'node:crypto'
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join, relative, sep } from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import type { SuperAgentConfig, SuperAgentEnvironment, SuperAgentSessionPolicy, SuperAgentEnvironmentStatus } from '@craft-agent/shared/super-agent'

const executeFile = promisify(execFile)
const MAX_RUNTIME_OUTPUT = 512 * 1024
const IMAGE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/

export interface ContainerProgramExecutor {
  runtimePath: string
  containerId: string
  workingDirectory: string
}

type RuntimeRun = (executable: string, args: string[], timeout: number) => Promise<string>

/** Only the configured working folder is mounted. No host environment is sent to a container. */
export function sandboxArguments(name: string, root: string, environment: SuperAgentEnvironment): string[] {
  const sandbox = environment.sandbox
  if (!sandbox || !IMAGE_PATTERN.test(sandbox.image)) throw new Error('Use a valid container image name')
  if (!/^tokenbird-super-[a-f0-9-]+$/.test(name)) throw new Error('Invalid managed container name')
  if (root.includes(',') || /[\r\n\x00]/.test(root)) throw new Error('Container folders may not contain commas or control characters')
  if (environment.permissions.runPrograms && !environment.permissions.readFiles) {
    throw new Error('Sandbox programs require file read permission')
  }
  const mount = environment.permissions.readFiles || environment.permissions.writeFiles
    ? ['--mount', `type=bind,source=${root},target=/workspace${environment.permissions.writeFiles ? '' : ',readonly'}`]
    : ['--tmpfs', '/workspace:rw,nosuid,nodev,size=67108864']
  return [
    'run', '--name', name, '--label', 'app.tokenbird.super-agent=true',
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=128', '--memory=1g', '--cpus=2', '--network=none',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456',
    '--workdir', '/workspace', ...mount,
    '--entrypoint', '/bin/sh', sandbox.image,
  ]
}

export class SuperAgentEnvironments {
  private readonly runtimes = new Map<string, string>()
  private readonly probes = new Map<string, { checkedAt: number; error?: string }>()
  private readonly containers = new Map<string, ContainerProgramExecutor>()
  private readonly owners = new Map<string, string>()
  private readonly allowedContainers = new Map<string, Set<string>>()
  private readonly reconcileVersions = new Map<string, number>()
  private readonly preparing = new Map<string, Promise<ContainerProgramExecutor>>()
  private readonly removing = new Map<string, Promise<void>>()
  private readonly run: RuntimeRun
  private closed = false

  constructor(private readonly options: {
    findRuntime?: (runtime: 'docker' | 'podman') => Promise<string>
    run?: RuntimeRun
    /** True only when the server owner explicitly identifies this server as a VM. */
    isVmHost?: boolean
  } = {}) {
    this.run = options.run ?? (async (executable, args, timeout) => {
      const { stdout } = await executeFile(executable, args, { timeout, maxBuffer: MAX_RUNTIME_OUTPUT, windowsHide: true, encoding: 'utf8' })
      return stdout.trim()
    })
  }

  async resolve(workspaceId: string, environment: SuperAgentEnvironment): Promise<{ status: SuperAgentEnvironmentStatus; workingDirectory: string }> {
    const root = await this.folder(environment.workingDirectory)
    if (environment.kind === 'folder') {
      return { workingDirectory: root, status: { available: true, isolation: 'host-folder', detail: '文件工具限定在工作目录；通用程序请使用沙箱。已登记脚本按程序权限和执行模式运行。' } }
    }
    if (environment.kind === 'vm') {
      const available = this.options.isVmHost === true && environment.vm?.workspaceId === workspaceId
      return { workingDirectory: root, status: {
        available, isolation: available ? 'remote-vm' : 'unavailable',
        detail: available ? '任务在当前已连接的虚拟机服务工作区内执行。' : '请连接虚拟机内的 TokenBird 服务工作区，并在该服务设置 TOKENBIRD_EXECUTION_HOST=vm。',
      } }
    }
    if (!environment.sandbox) throw new Error('Choose a sandbox runtime and image')
    try {
      const executable = await this.runtime(environment.sandbox.runtime)
      const cached = this.probes.get(executable)
      if (!cached || Date.now() - cached.checkedAt > 15_000) {
        try {
          await this.run(executable, ['info', '--format', '{{json .}}'], 10_000)
          this.probes.set(executable, { checkedAt: Date.now() })
        } catch (error) {
          this.probes.set(executable, { checkedAt: Date.now(), error: this.error(error) })
        }
      }
      const error = this.probes.get(executable)?.error
      if (error) throw new Error(error)
      sandboxArguments('tokenbird-super-000000', root, environment)
      return { workingDirectory: root, status: { available: true, isolation: 'container', detail: `${environment.sandbox.runtime} 沙箱：${environment.sandbox.image}。仅挂载工作目录，网络关闭；首次运行会准备镜像。` } }
    } catch (error) {
      return { workingDirectory: root, status: { available: false, isolation: 'unavailable', detail: `沙箱不可用：${this.error(error)}` } }
    }
  }

  async prepareSession(workspaceId: string, environment: SuperAgentEnvironment, policy: SuperAgentSessionPolicy): Promise<ContainerProgramExecutor | undefined> {
    if (this.closed) throw new Error('Execution environments are shutting down')
    if (environment.kind !== 'sandbox' || !policy.runPrograms) return undefined
    const resolved = await this.resolve(workspaceId, environment)
    if (!resolved.status.available) throw new Error(resolved.status.detail)
    const name = this.nodeContainerName(workspaceId, policy.nodeId, environment, resolved.workingDirectory)
    if (this.allowedContainers.has(workspaceId) && !this.allowedContainers.get(workspaceId)!.has(name)) throw new Error('Node sandbox settings changed during preparation')
    await this.removing.get(name)
    const existing = this.containers.get(name)
    if (existing) return existing
    let preparing = this.preparing.get(name)
    if (!preparing) {
      preparing = this.createContainer(workspaceId, name, resolved.workingDirectory, environment)
      this.preparing.set(name, preparing)
    }
    try { return await preparing } finally { this.preparing.delete(name) }
  }

  /** Retire idle containers when nodes or environment settings change. */
  async reconcile(workspaceId: string, config: SuperAgentConfig): Promise<void> {
    const generation = (this.reconcileVersions.get(workspaceId) ?? 0) + 1
    this.reconcileVersions.set(workspaceId, generation)
    const allowed = new Set<string>()
    if (config.environment.kind === 'sandbox' && config.environment.permissions.runPrograms) {
      try {
        const root = await this.folder(config.environment.workingDirectory)
        for (const node of config.nodes.filter(node => node.role === 'worker')) allowed.add(this.nodeContainerName(workspaceId, node.id, config.environment, root))
      } catch { /* Invalid folders stay unavailable; retire their old containers. */ }
    }
    if (this.reconcileVersions.get(workspaceId) !== generation) return
    this.allowedContainers.set(workspaceId, allowed)
    const stale = Array.from(this.owners).filter(([name, owner]) => owner === workspaceId && !allowed.has(name))
    const results = await Promise.allSettled(stale.map(([name]) => {
      if (this.reconcileVersions.get(workspaceId) !== generation) return Promise.resolve()
      const executor = this.containers.get(name)
      return executor ? this.remove(executor) : Promise.resolve()
    }))
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Obsolete Super Agent containers could not be stopped')
  }

  private nodeContainerName(workspaceId: string, nodeId: string, environment: SuperAgentEnvironment, root: string): string {
    const hash = createHash('sha256').update(JSON.stringify({ workspaceId, nodeId, environment, root })).digest('hex').slice(0, 24)
    return `tokenbird-super-${hash}`
  }

  private async createContainer(workspaceId: string, name: string, root: string, environment: SuperAgentEnvironment): Promise<ContainerProgramExecutor> {
    const executable = await this.runtime(environment.sandbox!.runtime)
    // Remove only a container deterministically owned by this workspace/node,
    // e.g. one left behind by a prior application crash.
    try {
      const owned = await this.run(executable, ['inspect', '--format', '{{ index .Config.Labels "app.tokenbird.super-agent" }}', name], 10_000)
      if (owned !== 'true') throw new Error('The sandbox name is already used by another container')
      await this.run(executable, ['rm', '--force', name], 15_000)
    } catch (error) {
      if (this.error(error).includes('already used')) throw error
    }
    const args = sandboxArguments(name, root, environment)
    // Detached container stays available for serial turns in this node.
    args.splice(1, 0, '--detach')
    await this.run(executable, [...args, '-c', 'trap "exit 0" TERM INT; while :; do sleep 3600; done'], 180_000)
    const executor = { runtimePath: executable, containerId: name, workingDirectory: '/workspace' }
    this.containers.set(name, executor)
    this.owners.set(name, workspaceId)
    if (this.closed) { await this.remove(executor); throw new Error('Execution environments are shutting down') }
    if (this.allowedContainers.has(workspaceId) && !this.allowedContainers.get(workspaceId)!.has(name)) {
      await this.remove(executor)
      throw new Error('Node sandbox settings changed during preparation')
    }
    return executor
  }

  /** Scripts get a separate disposable container so stop/timeout terminates its entire process tree. */
  async spawnScript(workspaceId: string, environment: SuperAgentEnvironment, path: string, args: string[]): Promise<{ child: ChildProcess; stop: () => Promise<void> }> {
    const resolved = await this.resolve(workspaceId, environment)
    if (!resolved.status.available || environment.kind !== 'sandbox') throw new Error(resolved.status.detail)
    const childPath = relative(resolved.workingDirectory, await realpath(path))
    if (childPath === '..' || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) throw new Error('Script is outside the sandbox folder')
    const scriptPath = `/workspace/${childPath.split(sep).join('/')}`
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
    const interpreters: Record<string, string[]> = { '.js': ['node'], '.mjs': ['node'], '.cjs': ['node'], '.py': ['python3'], '.sh': ['/bin/sh'], '.ps1': ['pwsh', '-NoProfile', '-NonInteractive', '-File'] }
    const interpreter = interpreters[extension]
    if (!interpreter) throw new Error('Unsupported sandbox script extension')
    const executable = await this.runtime(environment.sandbox!.runtime)
    const name = `tokenbird-super-${randomUUID()}`
    const launchArgs = sandboxArguments(name, resolved.workingDirectory, environment)
    launchArgs.splice(1, 0, '--rm')
    // Override the image's entrypoint using discrete arguments, with no shell interpolation.
    launchArgs[launchArgs.indexOf('--entrypoint') + 1] = interpreter[0]!
    const child = spawn(executable, [...launchArgs, ...interpreter.slice(1), scriptPath, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    const executor = { runtimePath: executable, containerId: name, workingDirectory: '/workspace' }
    this.containers.set(name, executor)
    child.once('close', () => { void this.remove(executor).catch(() => undefined) })
    return { child, stop: async () => { await this.remove(executor); child.kill() } }
  }

  async cleanup(): Promise<void> {
    this.closed = true
    await Promise.allSettled(Array.from(this.preparing.values()))
    const results = await Promise.allSettled(Array.from(this.containers.values(), executor => this.remove(executor)))
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Some Super Agent containers could not be stopped')
  }

  private async remove(executor: ContainerProgramExecutor): Promise<void> {
    const existing = this.removing.get(executor.containerId)
    if (existing) return existing
    const pending = (async () => {
      try { await this.run(executor.runtimePath, ['rm', '--force', executor.containerId], 15_000) }
      catch (error) { if (!/no such (container|object)|container .* does not exist/i.test(this.error(error))) throw error }
      this.containers.delete(executor.containerId)
      this.owners.delete(executor.containerId)
    })()
    this.removing.set(executor.containerId, pending)
    try { await pending } finally { this.removing.delete(executor.containerId) }
  }

  private async folder(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new Error('Choose an absolute working directory')
    const canonical = await realpath(path)
    if (!(await stat(canonical)).isDirectory()) throw new Error('Working directory does not exist')
    return canonical
  }

  private async runtime(runtime: 'docker' | 'podman'): Promise<string> {
    let executable = this.runtimes.get(runtime)
    if (executable) return executable
    if (this.options.findRuntime) executable = await this.options.findRuntime(runtime)
    else {
      const names = process.platform === 'win32' ? [`${runtime}.exe`, runtime] : [runtime]
      for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)) {
        for (const name of names) {
          const candidate = join(directory.replace(/^"|"$/g, ''), name)
          try { await access(candidate, constants.X_OK); executable = await realpath(candidate); break } catch { /* try the next PATH entry */ }
        }
        if (executable) break
      }
    }
    if (!executable || !isAbsolute(executable)) throw new Error(`Install and start ${runtime} on the workspace server`)
    this.runtimes.set(runtime, executable)
    return executable
  }

  private error(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2_000) }
}

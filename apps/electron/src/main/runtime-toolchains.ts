import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { getRuntimeToolPaths, setRuntimeToolPath } from '@craft-agent/shared/config/storage'
import type { RuntimeToolId, RuntimeToolStatus } from '@craft-agent/shared/config/types'

const EXECUTABLE_NAMES: Record<RuntimeToolId, string> = {
  java: process.platform === 'win32' ? 'java.exe' : 'java',
  python: process.platform === 'win32' ? 'python.exe' : 'python3',
  node: process.platform === 'win32' ? 'node.exe' : 'node',
}

let injectedPathEntries: string[] = []
const originalJavaHome = process.env.JAVA_HOME

function bundledExecutable(tool: RuntimeToolId): string | undefined {
  const root = process.env.CRAFT_RESOURCES_BASE
  if (!root) return undefined
  const candidates: Record<RuntimeToolId, string[]> = {
    java: [join(root, 'vendor', 'toolchains', 'jdk', 'bin', EXECUTABLE_NAMES.java)],
    python: [join(root, 'vendor', 'toolchains', 'python', EXECUTABLE_NAMES.python)],
    node: [join(root, 'vendor', 'toolchains', 'node', EXECUTABLE_NAMES.node)],
  }
  return candidates[tool].find(existsSync)
}

export function resolveRuntimeToolExecutable(tool: RuntimeToolId, input: string): string | undefined {
  const candidate = resolve(input.trim())
  if (!existsSync(candidate)) return undefined
  if (statSync(candidate).isFile()) return candidate
  const names = tool === 'java'
    ? [join(candidate, 'bin', EXECUTABLE_NAMES.java), join(candidate, EXECUTABLE_NAMES.java)]
    : tool === 'python'
      ? [join(candidate, EXECUTABLE_NAMES.python), join(candidate, 'python.exe'), join(candidate, 'python3.exe')]
      : [join(candidate, EXECUTABLE_NAMES.node)]
  return names.find(path => existsSync(path) && statSync(path).isFile())
}

function pathEntries(tool: RuntimeToolId, executable: string): string[] {
  const bin = dirname(executable)
  if (tool === 'python' && process.platform === 'win32') return [bin, join(bin, 'Scripts')]
  return [bin]
}

function removeInjectedEntries(): void {
  const prior = new Set(injectedPathEntries.map(path => path.toLowerCase()))
  process.env.PATH = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(path => path && !prior.has(path.toLowerCase()))
    .join(delimiter)
  injectedPathEntries = []
}

/** Apply persisted overrides, falling back to bundled runtimes, to every new child process. */
export function applyRuntimeToolEnvironment(): void {
  removeInjectedEntries()
  const configured = getRuntimeToolPaths()
  const resolved = (['java', 'python', 'node'] as RuntimeToolId[]).map(tool => ({
    tool,
    executable: configured[tool]
      ? resolveRuntimeToolExecutable(tool, configured[tool]!)
      : bundledExecutable(tool),
  }))

  for (const item of resolved) {
    if (!item.executable) continue
    injectedPathEntries.push(...pathEntries(item.tool, item.executable))
    if (item.tool === 'java') process.env.JAVA_HOME = dirname(dirname(item.executable))
    if (item.tool === 'python') process.env.CRAFT_PYTHON = item.executable
    if (item.tool === 'node') process.env.CRAFT_NODE = item.executable
  }
  if (!resolved.some(item => item.tool === 'java' && item.executable)) {
    if (originalJavaHome) process.env.JAVA_HOME = originalJavaHome
    else delete process.env.JAVA_HOME
  }
  if (!resolved.some(item => item.tool === 'python' && item.executable)) delete process.env.CRAFT_PYTHON
  if (!resolved.some(item => item.tool === 'node' && item.executable)) delete process.env.CRAFT_NODE
  process.env.PATH = [...new Set(injectedPathEntries), process.env.PATH ?? ''].filter(Boolean).join(delimiter)
}

function versionFor(tool: RuntimeToolId, executable: string): string | undefined {
  try {
    const output = execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return output.trim().split(/\r?\n/)[0]
  } catch (error) {
    // java -version writes to stderr; retry through spawn output is unnecessary
    // because execFileSync exposes that text on the thrown error.
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim()
    return stderr?.split(/\r?\n/)[0]
  }
}

export function getRuntimeToolStatuses(): RuntimeToolStatus[] {
  const configured = getRuntimeToolPaths()
  return (['java', 'python', 'node'] as RuntimeToolId[]).map((id) => {
    const custom = configured[id]
    const bundled = bundledExecutable(id)
    const executable = custom ? resolveRuntimeToolExecutable(id, custom) : bundled
    if (custom && !executable) {
      return { id, source: 'missing', configuredPath: custom, available: false, error: 'Configured path does not contain a supported executable' }
    }
    if (executable) {
      const version = versionFor(id, executable)
      return {
        id,
        source: custom ? 'custom' : 'bundled',
        configuredPath: custom,
        executablePath: executable,
        version,
        available: Boolean(version),
        error: version ? undefined : 'Executable could not be started',
      }
    }
    const command = EXECUTABLE_NAMES[id]
    const version = versionFor(id, command)
    return { id, source: version ? 'system' : 'missing', version, executablePath: version ? command : undefined, available: Boolean(version) }
  })
}

export function updateRuntimeToolPath(tool: RuntimeToolId, input?: string): RuntimeToolStatus[] {
  const normalized = input?.trim()
  if (normalized && !resolveRuntimeToolExecutable(tool, normalized)) {
    throw new Error(`The selected path does not contain ${EXECUTABLE_NAMES[tool]}`)
  }
  if (!setRuntimeToolPath(tool, normalized || undefined)) throw new Error('Failed to save runtime tool path')
  applyRuntimeToolEnvironment()
  return getRuntimeToolStatuses()
}

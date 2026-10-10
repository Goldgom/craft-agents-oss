import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { BuildConfig } from './common'

const execute = promisify(execFile)

/** Install into the actual packaged Python, never a developer's global interpreter. */
export async function installWindowsAgentFramework(config: BuildConfig): Promise<void> {
  if (config.platform !== 'win32') return
  const python = join(config.electronDir, 'vendor', 'toolchains', 'python', 'python.exe')
  const check = ['-c', 'from importlib.metadata import version; assert version("agent-framework-core") == "1.21.0"']
  try {
    await execute(python, check, { windowsHide: true, timeout: 30_000 })
    return
  } catch {
    const requirements = join(config.rootDir, 'deploy', 'agent-framework', 'requirements.txt')
    await execute(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements], {
      windowsHide: true, timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
    })
    await execute(python, check, { windowsHide: true, timeout: 30_000 })
    console.log('Microsoft Agent Framework installed in packaged Python')
  }
}

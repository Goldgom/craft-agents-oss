import { stat } from 'fs/promises'
import { join } from 'path'

const BUNDLED_GIT_BASH_RELATIVE_PATH = ['vendor', 'git-bash', 'bin', 'bash.exe'] as const

/**
 * Resolve the Git Bash runtime shipped with the desktop app.
 * CRAFT_RESOURCES_BASE points at resources/app in packages and apps/electron
 * during development. Returning undefined keeps headless/non-Electron runtimes
 * independent from the desktop resource layout.
 */
export function getBundledGitBashPath(resourcesBase = process.env.CRAFT_RESOURCES_BASE): string | undefined {
  const trimmedBase = resourcesBase?.trim()
  if (!trimmedBase) return undefined
  return join(trimmedBase, ...BUNDLED_GIT_BASH_RELATIVE_PATH)
}

/**
 * Basic file-name validation for Git Bash executable paths.
 * Accepts Windows-style and POSIX-style separators to support cross-platform tests.
 */
export function isGitBashExecutablePath(filePath: string): boolean {
  return /(?:^|[\\/])bash\.exe$/i.test(filePath.trim())
}

/**
 * Validate a user-provided Git Bash executable path.
 * Enforces bash.exe filename and existence on disk.
 */
export async function validateGitBashPath(filePath: string): Promise<{ valid: true; path: string } | { valid: false; error: string }> {
  const trimmedPath = filePath.trim()

  if (!isGitBashExecutablePath(trimmedPath)) {
    return { valid: false, error: 'Path must point to bash.exe' }
  }

  try {
    const info = await stat(trimmedPath)
    if (!info.isFile()) {
      return { valid: false, error: 'Path must point to a file' }
    }
    return { valid: true, path: trimmedPath }
  } catch {
    return { valid: false, error: 'File does not exist at the specified path' }
  }
}

/**
 * Check if a Git Bash path is usable without returning UI-facing errors.
 */
export async function isUsableGitBashPath(filePath: string): Promise<boolean> {
  const result = await validateGitBashPath(filePath)
  return result.valid
}

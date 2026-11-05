import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { spawnSync } from 'child_process'
import {
  configureBundledGitCredentials,
  GIT_FOR_WINDOWS_VERSION,
  getGitForWindowsDownloadName,
} from './common'

describe('PortableGit build configuration', () => {
  it('pins the current Windows servicing release and resolves its x64 asset', () => {
    expect(GIT_FOR_WINDOWS_VERSION).toBe('2.55.0.windows.3')
    expect(getGitForWindowsDownloadName('x64')).toBe('PortableGit-2.55.0.3-64-bit.7z.exe')
  })

  it('rejects architectures without an official bundled runtime', () => {
    expect(() => getGitForWindowsDownloadName('arm64')).toThrow(
      'Bundled Git Bash is not available for Windows arm64',
    )
  })
})

const bundledGit = resolve(import.meta.dir, '../../apps/electron/vendor/git-bash')
const hasBundledGit = process.platform === 'win32' && existsSync(join(bundledGit, 'cmd', 'git.exe'))

describe.skipIf(!hasBundledGit)('bundled Git credential configuration', () => {
  function withGitConfig(contents: string, check: (root: string, configPath: string) => void) {
    const root = mkdtempSync(join(tmpdir(), 'tokenbird-git-credentials-'))
    try {
      // Use the real bundled executable and dependencies with an isolated system config.
      symlinkSync(join(bundledGit, 'cmd'), join(root, 'cmd'), 'junction')
      symlinkSync(join(bundledGit, 'mingw64'), join(root, 'mingw64'), 'junction')
      mkdirSync(join(root, 'etc'))
      const configPath = join(root, 'etc', 'gitconfig')
      writeFileSync(configPath, contents)
      check(root, configPath)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('replaces every selector while preserving other helpers and settings, and is idempotent', () => {
    withGitConfig('[core]\n\tautocrlf = true\n[credential]\n\thelper = helper-selector\n\thelper = cache\n\thelper = helper-selector\n[credential "https://example.com"]\n\thelper = custom-helper\n', (root, configPath) => {
      configureBundledGitCredentials(root)
      const helpers = spawnSync(join(root, 'cmd', 'git.exe'), ['config', '--file', configPath, '--get-all', 'credential.helper'], { encoding: 'utf8' })
      expect(helpers.status).toBe(0)
      expect(helpers.stdout.trim().split(/\r?\n/)).toEqual(['cache', 'manager'])
      const configured = readFileSync(configPath, 'utf8')
      expect(configured).toContain('autocrlf = true')
      expect(configured).toContain('custom-helper')
      configureBundledGitCredentials(root)
      expect(readFileSync(configPath, 'utf8')).toBe(configured)
    })
  }, 30_000)

  it('keeps an explicit existing configuration unchanged', () => {
    const configured = '[credential]\n\thelper = custom-helper\n'
    withGitConfig(configured, (root, configPath) => {
      configureBundledGitCredentials(root)
      expect(readFileSync(configPath, 'utf8')).toBe(configured)
    })
    withGitConfig('[core]\n\tautocrlf = true\n', (root, configPath) => {
      configureBundledGitCredentials(root)
      expect(readFileSync(configPath, 'utf8')).toBe('[core]\n\tautocrlf = true\n')
    })
  }, 30_000)
})

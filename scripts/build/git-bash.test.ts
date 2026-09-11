import { describe, expect, it } from 'bun:test'
import {
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

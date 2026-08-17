import { describe, expect, it } from 'bun:test'
import { isRemotePathWithinRoot } from './sftp'

describe('isRemotePathWithinRoot', () => {
  it('accepts paths inside a configured root', () => {
    expect(isRemotePathWithinRoot('/srv/craft/file.zip', '/srv/craft')).toBe(true)
    expect(isRemotePathWithinRoot('/srv/craft', '/srv/craft')).toBe(true)
  })

  it('rejects sibling and traversal-normalized paths', () => {
    expect(isRemotePathWithinRoot('/srv/craft-other/file.zip', '/srv/craft')).toBe(false)
    expect(isRemotePathWithinRoot('/srv/craft/../secret.txt', '/srv/craft')).toBe(false)
  })

  it('allows absolute paths when the configured root is the filesystem root', () => {
    expect(isRemotePathWithinRoot('/var/backups/file.zip', '/')).toBe(true)
  })
})

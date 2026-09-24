import { describe, expect, it } from 'bun:test'
import { resolveStudioAsset } from './studio-protocol-path'
import { join } from 'node:path'

const root = join(process.cwd(), 'renderer', 'drawio')

describe('bundled draw.io path resolution', () => {
  it('keeps ordinary assets inside the fixed runtime directory', () => {
    const asset = resolveStudioAsset(root, '/resources/dia.txt')
    expect(asset?.replaceAll('\\', '/')).toEndWith('/renderer/drawio/resources/dia.txt')
  })

  it('rejects path traversal and malformed encoding', () => {
    expect(resolveStudioAsset(root, '/../secret')).toBeNull()
    expect(resolveStudioAsset(root, '/%2e%2e/secret')).toBeNull()
    expect(resolveStudioAsset(root, '/%5csecret')).toBeNull()
    expect(resolveStudioAsset(root, '/%ZZ')).toBeNull()
  })
})

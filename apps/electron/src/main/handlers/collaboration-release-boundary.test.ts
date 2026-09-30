import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// This is a release-surface check, not acceptance of the dormant experiment.
describe('mixed-server experiment release boundary', () => {
  test('does not register experimental RPC or native main entrypoints', () => {
    const main = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const rpc = readFileSync(new URL('../../../../../packages/server-core/src/handlers/rpc/index.ts', import.meta.url), 'utf8')
    expect(main).not.toContain('registerCollaborationRelayHandlers(')
    expect(main).not.toContain('registerCollaborationMultiServerHandlers(')
    expect(main).not.toContain('new CollaborationRelayManager(')
    expect(rpc).not.toContain('registerCollaborationRelayHandlers(')
  })
  test('preload exposes only the established collaboration implementation', () => {
    const preload = readFileSync(new URL('../../preload/bootstrap.ts', import.meta.url), 'utf8')
    for (const method of ['createMultiServerCollaboration', 'listMultiServerCollaborations', 'getMultiServerCollaborationContext']) {
      expect(preload).not.toMatch(new RegExp(`\\.${method}\\s*=`))
    }
    expect(preload).toContain('createRemoteCollaboration =')
  })
})

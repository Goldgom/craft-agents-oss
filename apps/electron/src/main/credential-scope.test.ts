import { expect, it } from 'bun:test'
import { sourceCredentialWorkspaceId, workspaceForSourceCredentialId } from './credential-scope'

it('resolves the actual legacy source namespace without guessing from app UUID or display name', () => {
  const spaces = [{ id: 'generated-uuid', rootPath: '/tmp/projects/source-folder' }]
  expect(sourceCredentialWorkspaceId('generated-uuid', spaces)).toBe('source-folder')
  expect(workspaceForSourceCredentialId('source-folder', spaces)?.id).toBe('generated-uuid')
  expect(workspaceForSourceCredentialId('generated-uuid', spaces)).toBeUndefined()
})

it('does not expose an ambiguous namespace or assign remote stubs as local owners', () => {
  const spaces = [
    { id: 'alpha', rootPath: '/tmp/a/project' }, { id: 'beta', rootPath: '/tmp/b/project' },
    { id: 'remote', rootPath: '/tmp/remote/source-folder', remoteServer: {} },
    { id: 'local', rootPath: '/tmp/local/source-folder' },
  ]
  expect(sourceCredentialWorkspaceId('alpha', spaces)).toBeNull()
  expect(sourceCredentialWorkspaceId('beta', spaces)).toBeNull()
  expect(workspaceForSourceCredentialId('project', spaces)).toBeUndefined()
  expect(sourceCredentialWorkspaceId('remote', spaces)).toBeNull()
  expect(sourceCredentialWorkspaceId('local', spaces)).toBe('source-folder')
  expect(sourceCredentialWorkspaceId('relative', [{ id: 'relative', rootPath: 'project' }])).toBeNull()
  expect(sourceCredentialWorkspaceId('parent', [{ id: 'parent', rootPath: '/tmp/project/..' }])).toBeNull()
})

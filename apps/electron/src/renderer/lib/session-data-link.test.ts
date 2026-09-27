import { describe, expect, it } from 'bun:test'
import type { SessionFile } from '@craft-agent/shared/protocol'
import { findSessionDataLink } from './session-data-link'

const files: SessionFile[] = [{
  name: 'data',
  path: 'C:\\Users\\goldg\\.tokenbird\\workspaces\\my-workspace\\sessions\\260926-ivory-halo\\data',
  type: 'directory',
  children: [{
    name: '供件排班_2026年10月已完成.xlsx',
    path: 'C:\\Users\\goldg\\.tokenbird\\workspaces\\my-workspace\\sessions\\260926-ivory-halo\\data\\供件排班_2026年10月已完成.xlsx',
    type: 'file',
  }],
}]

describe('findSessionDataLink', () => {
  it('resolves a workspace data link to the actual session output', () => {
    expect(findSessionDataLink(
      'C:\\Users\\goldg\\.tokenbird\\workspaces\\my-workspace\\data\\供件排班_2026年10月已完成.xlsx',
      'C:\\Users\\goldg\\.tokenbird\\workspaces\\my-workspace',
      files,
    )).toBe(files[0]!.children![0]!.path)
  })

  it('does not redirect other workspaces or missing files', () => {
    expect(findSessionDataLink('C:\\other\\data\\供件排班_2026年10月已完成.xlsx', 'C:\\Users\\goldg\\.tokenbird\\workspaces\\my-workspace', files)).toBeNull()
    expect(findSessionDataLink('C:\\Users\\goldg\\.tokenbird\\workspaces\\my-workspace\\data\\missing.xlsx', 'C:\\Users\\goldg\\.tokenbird\\workspaces\\my-workspace', files)).toBeNull()
  })
})

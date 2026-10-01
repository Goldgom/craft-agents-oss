import { describe, expect, it } from 'bun:test'
import { resolveSessionFileLink } from '../session-data-link'
import { isAbsolutePath } from '../drafts'

describe('session file link resolution', () => {
  it('resolves default outputs against the session, not workspace root', () => {
    expect(resolveSessionFileLink('./data/report.pdf', undefined, '/server/workspace', 'abc'))
      .toBe('/server/workspace/sessions/abc/data/report.pdf')
  })
  it('uses the explicitly selected project', () => {
    expect(resolveSessionFileLink('report.md', 'E:\\Projects\\demo\\', '/workspace', 'abc'))
      .toBe('E:\\Projects\\demo/report.md')
  })
  it('preserves absolute and home paths owned by the server', () => {
    for (const path of ['E:\\demo\\report.md', '\\\\server\\share\\report.pdf', '~/report.md', '~\\report.md', '${HOME}/report.md']) {
      expect(resolveSessionFileLink(path, '/other', '/workspace', 'abc')).toBe(path)
    }
    expect(isAbsolutePath('\\\\server\\share\\report.pdf')).toBe(true)
  })
})
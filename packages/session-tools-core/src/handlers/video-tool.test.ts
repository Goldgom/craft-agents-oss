import { describe, expect, test } from 'bun:test'
import { handleVideoTool } from './video-tool'
import { getToolDefsAsJsonSchema, getSessionSafeBlockedToolNames } from '../tool-defs'
import type { SessionToolContext } from '../context'

describe('video_tool registration and bridge', () => {
  test('advertises the same typed tool to all backends and blocks Explore mutations', () => {
    const definition = getToolDefsAsJsonSchema({ prefix: 'mcp__session__' }).find(def => def.name === 'mcp__session__video_tool')!
    expect(definition.inputSchema.required).toContain('action')
    expect(getSessionSafeBlockedToolNames().has('video_tool')).toBe(true)
  })
  test('forwards job results without fabricating success', async () => {
    const context = {} as SessionToolContext
    expect((await handleVideoTool(context, { action: 'state' })).isError).toBe(true)
    context.videoToolFn = async request => ({ action: request.action, id: 'persisted-job', status: 'running' })
    const result = await handleVideoTool(context, { action: 'generate_project', args: { projectId: 'project' } })
    expect(result.isError).not.toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('persisted-job') })
  })
  test('rejects provider credentials and unconfirmed deletion before executing', async () => {
    let calls = 0
    const context = { videoToolFn: async () => { calls++; return {} } } as unknown as SessionToolContext
    expect((await handleVideoTool(context, { action: 'save_provider', args: { apiKey: 'private' } })).isError).toBe(true)
    expect((await handleVideoTool(context, { action: 'delete_project', args: { id: 'project' } })).isError).toBe(true)
    expect(calls).toBe(0)
  })
})

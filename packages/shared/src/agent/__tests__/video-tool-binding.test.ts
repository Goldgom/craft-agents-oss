import { expect, test } from 'bun:test'
import { attachSessionSelfManagementBindings } from '../session-self-management-bindings'
import { mergeSessionScopedToolCallbacks, unregisterSessionScopedToolCallbacks } from '../session-scoped-tool-callback-registry'
import type { SessionToolContext } from '@tokenbird/session-tools-core'

test('video tool bindings resolve late registration and replacement for every session backend', async () => {
  const context = {} as SessionToolContext
  const sid = 'video-late-binding'
  try {
    attachSessionSelfManagementBindings(context, sid)
    expect(context.videoToolFn).toBeUndefined()
    mergeSessionScopedToolCallbacks(sid, { videoToolFn: async input => ({ action: input.action, host: 'first' }) })
    expect(await context.videoToolFn?.({ action: 'state' })).toEqual({ action: 'state', host: 'first' })
    mergeSessionScopedToolCallbacks(sid, { videoToolFn: async () => ({ host: 'replacement' }) })
    expect(await context.videoToolFn?.({ action: 'state' })).toEqual({ host: 'replacement' })
  } finally { unregisterSessionScopedToolCallbacks(sid) }
})

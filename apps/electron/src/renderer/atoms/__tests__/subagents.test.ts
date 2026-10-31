import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { Session } from '../../../shared/types'
import {
  initializeSessionsAtom, sessionMetaMapAtom, updateSessionMetaAtom, subagentSessionsAtomFamily,
  sessionDetailsReadersAtom, releaseSessionMessagesAtom, sessionAtomFamily, replaceLoadedSessionAtom,
} from '../sessions'

function session(id: string, fields: Partial<Session> = {}): Session {
  return { id, workspaceId: 'ws', workspaceName: 'Workspace', messages: [], isProcessing: false, lastMessageAt: 1, ...fields }
}

describe('subagent details state', () => {
  it('keeps the dispatch icon accessible when history chooses a different conversation branch', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [session('main'), session('branch', { branchFromSessionId: 'main', branchFromMessageId: 'm' }),
      session('child', { parentSessionId: 'main' }), session('branch-child', { parentSessionId: 'branch' })])
    expect(store.get(subagentSessionsAtomFamily('branch')).map(child => child.id)).toEqual(['branch-child', 'child'])
    expect(store.get(subagentSessionsAtomFamily('main')).map(child => child.id)).toEqual(['branch-child', 'child'])
  })
  it('observes dispatch, progress, completion and deletion, excluding hidden and foreign children', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [session('main'), session('other')])
    const children = subagentSessionsAtomFamily('main')
    const unsubscribe = store.sub(children, () => {})
    expect(store.get(children)).toEqual([])
    const map = new Map(store.get(sessionMetaMapAtom))
    map.set('child', { id: 'child', workspaceId: 'ws', parentSessionId: 'main', isProcessing: true })
    map.set('hidden', { id: 'hidden', workspaceId: 'ws', parentSessionId: 'main', hidden: true })
    map.set('foreign', { id: 'foreign', workspaceId: 'other-ws', parentSessionId: 'main' })
    store.set(sessionMetaMapAtom, map)
    expect(store.get(children).map(child => child.id)).toEqual(['child'])
    expect(store.get(children)[0]?.isProcessing).toBe(true)
    const before = store.get(children)
    store.set(updateSessionMetaAtom, 'other', { isProcessing: true, lastMessageAt: 5 })
    expect(store.get(children)).toBe(before)
    store.set(updateSessionMetaAtom, 'child', { isProcessing: false, hasUnread: true })
    expect(store.get(children)[0]).toMatchObject({ isProcessing: false, hasUnread: true })
    store.set(sessionMetaMapAtom, new Map([...map].filter(([id]) => id !== 'child')))
    expect(store.get(children)).toEqual([])
    unsubscribe()
  })

  it('protects a dialog transcript from panel cleanup until its last reader closes', async () => {
    const store = createStore()
    const child = session('child', { parentSessionId: 'main', messages: [{ id: 'm', role: 'assistant', content: 'Result', timestamp: 1 }] })
    store.set(replaceLoadedSessionAtom, child)
    store.set(sessionDetailsReadersAtom, new Map([['child', 2]]))
    expect(await store.set(releaseSessionMessagesAtom, 'child')).toBe(false)
    expect(store.get(sessionAtomFamily('child'))?.messages).toHaveLength(1)
    store.set(sessionDetailsReadersAtom, new Map([['child', 1]]))
    expect(await store.set(releaseSessionMessagesAtom, 'child')).toBe(false)
    store.set(sessionDetailsReadersAtom, new Map())
    expect(await store.set(releaseSessionMessagesAtom, 'child')).toBe(true)
    expect(store.get(sessionAtomFamily('child'))?.messages).toEqual([])
    expect(store.get(sessionMetaMapAtom).get('child')?.parentSessionId).toBe('main')
  })
})

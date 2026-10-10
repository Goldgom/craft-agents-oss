import { describe, expect, test } from 'bun:test'
import { createSessionListRequestGuard } from '../session-load'
import { reconcileSessionPermissionModes } from '../session-permission-reconciliation'

const sessions = Array.from({ length: 300 }, (_, index) => ({ id: `session-${index}` }))

describe('bulk session permission reconciliation', () => {
  test('syncs a large history with bounded concurrency despite individual failures', async () => {
    let active = 0; let peak = 0
    const visited: string[] = []
    await reconcileSessionPermissionModes(sessions, async id => {
      visited.push(id)
      peak = Math.max(peak, ++active)
      await Bun.sleep(1)
      active--
      if (id === 'session-0') throw new Error('Unavailable session')
    }, () => true)
    expect(peak).toBe(8)
    expect(active).toBe(0)
    expect(visited).toHaveLength(300)
    expect(new Set(visited).size).toBe(300)
  })

  test('stops scheduling an old batch when a newer refresh takes ownership', async () => {
    const guard = createSessionListRequestGuard()
    const isCurrent = guard.begin()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const visited: string[] = []
    const pending = reconcileSessionPermissionModes(sessions, async id => {
      visited.push(id)
      await gate
    }, isCurrent)
    expect(visited).toHaveLength(8)
    guard.begin()
    release()
    await pending
    expect(visited).toHaveLength(8)
  })

  test('does not issue requests for an expired workspace or an empty history', async () => {
    let calls = 0
    const reconcile = async () => { calls++ }
    await reconcileSessionPermissionModes(sessions, reconcile, () => false)
    await reconcileSessionPermissionModes([], reconcile, () => true)
    expect(calls).toBe(0)
  })
})

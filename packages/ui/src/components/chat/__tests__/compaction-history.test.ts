import { describe, expect, it } from 'bun:test'
import type { Message } from '@craft-agent/core'
import { groupMessagesByTurn } from '../turn-utils'

const command: Message = { id: 'command', role: 'user', content: '/compact', timestamp: 1 }
const complete: Message = { id: 'done', role: 'info', content: 'Compacted context', statusType: 'compaction_complete', timestamp: 3 }

describe('compaction completion display', () => {
  it('shows completion after reloading history without transient progress', () => {
    const turns = groupMessagesByTurn([command, complete])
    expect(turns).toHaveLength(2)
    expect(turns[1]).toMatchObject({ type: 'system', message: complete })
  })
  it('updates live progress without duplicating completion', () => {
    const progress: Message = { id: 'progress', role: 'status', content: 'Compacting...', statusType: 'compacting', timestamp: 2 }
    const turns = groupMessagesByTurn([command, progress, complete])
    expect(turns).toHaveLength(2)
    expect(turns[1]).toMatchObject({ type: 'assistant', activities: [{ id: 'progress', content: complete.content, status: 'completed' }] })
  })
})

import { describe, expect, it } from 'bun:test'
import { resolveBranchMessageId, resolveBranchNewPanelOption } from '../branching'

describe('ChatDisplay branching navigation option', () => {
  it('uses confirmed IDs for live messages and preserves persisted history IDs', () => {
    const messages = [{ id: 'local', backendMessageId: 'stored', role: 'user' as const, content: 'question', timestamp: 1 }]
    expect(resolveBranchMessageId(messages, 'local')).toBe('stored')
    expect(resolveBranchMessageId(messages, 'stored')).toBe('stored')
    expect(resolveBranchMessageId([{ ...messages[0]!, backendMessageId: undefined }], 'local')).toBe('local')
  })

  it('defaults to opening in new panel when options are missing', () => {
    expect(resolveBranchNewPanelOption(undefined)).toBe(true)
  })

  it('respects explicit newPanel=false', () => {
    expect(resolveBranchNewPanelOption({ newPanel: false })).toBe(false)
  })

  it('respects explicit newPanel=true', () => {
    expect(resolveBranchNewPanelOption({ newPanel: true })).toBe(true)
  })
})

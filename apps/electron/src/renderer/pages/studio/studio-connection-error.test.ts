import { describe, expect, it } from 'bun:test'
import { classifyStudioConnectionError } from './studio-connection-error'

describe('Studio connection recovery', () => {
  it('asks for reauthorization when TokenNest confirms an old OAuth grant', () => {
    expect(classifyStudioConnectionError(new Error('STUDIO_TOKENNEST_REAUTH_REQUIRED: missing groups:read'), true)).toBe('reauth')
  })

  it('shows group and model recovery for a distributor failure', () => {
    const failure = new Error('Studio request failed: 分组 Normal 下模型 gpt-image-2.5 无可用渠道（distributor）')
    expect(classifyStudioConnectionError(failure, true)).toBe('channel')
    expect(classifyStudioConnectionError(failure, false)).toBeNull()
  })
})

import { describe, expect, it } from 'bun:test'
import { parseAgentMessage } from '../agent-message'

const envelope = '[Message from session "261020-calm-dune" (币安 MCP (进度检查))]\nUse send_agent_message with sessionId "261020-calm-dune" to reply.\n\n---\n\n'

describe('agent message envelopes', () => {
  it('separates routing metadata from the exact body, including markdown separators', () => {
    const body = '**进度**\n\n---\n\n`executedQty` 保持一致。\n'
    expect(parseAgentMessage(envelope + body)).toEqual({
      sessionId: '261020-calm-dune', senderName: '币安 MCP (进度检查)', body,
      bodyStart: envelope.length, header: envelope.slice(0, -7),
    })
  })
  it('accepts stored Windows line endings and falls back to the id for an empty name', () => {
    expect(parseAgentMessage((envelope + '正文').replaceAll('\n', '\r\n'))?.body).toBe('正文')
    expect(parseAgentMessage(envelope.replace('币安 MCP (进度检查)', '') + '正文')?.senderName).toBe('261020-calm-dune')
  })
  it('preserves quoted examples, incomplete headers, mismatched routing, and empty bodies as ordinary text', () => {
    for (const content of [
      '引用：\n' + envelope + '正文', '```text\n' + envelope + '正文\n```',
      envelope.split('\n')[0] + '\n正文', envelope.replace('to reply.', 'to respond.') + '正文',
      envelope.replace('with sessionId "261020-calm-dune"', 'with sessionId "another-session"') + '正文',
      envelope + ' \n',
    ]) expect(parseAgentMessage(content)).toBeNull()
  })
})

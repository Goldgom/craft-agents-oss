import { describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import type { Message } from '@tokenbird/core'
import { groupMessagesByTurn, deriveTurnPhase, formatTurnAsMarkdown, formatActivityAsMarkdown, type AssistantTurn } from '../turn-utils'

// Vite supplies this asset URL in the app; Bun does not transform ?url imports.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.min.mjs' }))
mock.module('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}))
const { TurnCard } = await import('../TurnCard')
const { SessionViewer } = await import('../SessionViewer')

const i18n = createInstance()
await i18n.init({ lng: 'en', resources: { en: { translation: {} } }, initImmediate: false })
const render = (children: React.ReactNode) => renderToStaticMarkup(React.createElement(I18nextProvider, { i18n, children }))
const human: Message = { id: 'human', role: 'user', content: '检查连接', timestamp: 1 }
const thinking: Message = { id: 'thinking', role: 'assistant', content: '先检查代理入口', isIntermediate: true, timestamp: 2 }
const peer: Message = {
  id: 'peer', role: 'user', timestamp: 3,
  content: '[Message from session "peer-session" (诊断助手)]\nUse send_agent_message with sessionId "peer-session" to reply.\n\n---\n\n**上游端口超时**',
  attachments: [{ id: 'image', type: 'image', name: 'chart.png', mimeType: 'image/png', size: 10, storedPath: '/chart.png', thumbnailBase64: 'preview' }],
}
const answer: Message = { id: 'answer', role: 'assistant', content: '已定位到上游端口', timestamp: 4 }

describe('shared thinking fold', () => {
  it('groups incoming peer messages with commentary and preserves the actual final response', () => {
    const turns = groupMessagesByTurn([human, thinking, peer, answer], { isSessionProcessing: false })
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ type: 'user', message: human })
    const turn = turns[1] as AssistantTurn
    expect(turn.activities.map(a => a.type)).toEqual(['intermediate', 'agent-message'])
    expect(turn.activities[1]?.sourceMessage).toBe(peer)
    expect(turn.response).toMatchObject({ text: answer.content, messageId: answer.id })
  })

  it('hides process text, peer bodies and attachments by default in the transcript', () => {
    const html = render(React.createElement(SessionViewer, { session: { id: 'session', messages: [human, thinking, peer, answer] } }))
    expect(html).toContain(human.content)
    expect(html).toContain(answer.content)
    expect(html).toContain('aria-expanded="false"')
    for (const text of [thinking.content, '上游端口超时', '诊断助手', 'Use send_agent_message', 'chart.png', 'data-agent-message']) {
      expect(html).not.toContain(text)
    }
  })

  it('shows the peer body, sender and attachments when manually expanded', () => {
    const turn = groupMessagesByTurn([human, thinking, peer, answer])[1] as AssistantTurn
    const html = render(React.createElement(TurnCard, { ...turn, isExpanded: true }))
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('data-agent-message')
    expect(html).toContain('诊断助手')
    expect(html).toContain('上游端口超时')
    expect(html).toContain('data-message-image')
    expect(html).toContain('chart.png')
    expect(html).toContain(thinking.content)
    expect(formatTurnAsMarkdown(turn)).toContain(peer.content)
    expect(formatActivityAsMarkdown(turn.activities[1]!)).toContain(peer.content)
  })

  it('keeps live thinking text inside the fold while streaming', () => {
    const turn = groupMessagesByTurn([human, { ...thinking, isPending: true, isStreaming: true }, peer], { isSessionProcessing: true })[1] as AssistantTurn
    const html = render(React.createElement(TurnCard, turn))
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain(thinking.content)
    expect(html).not.toContain('上游端口超时')
  })

  it('finishes peer-only activity without promoting it to a final answer', () => {
    const turn = groupMessagesByTurn([peer], { isSessionProcessing: false })[0] as AssistantTurn
    expect(turn.type).toBe('assistant')
    expect(deriveTurnPhase(turn)).toBe('complete')
    expect(turn.response).toBeUndefined()
    expect(render(React.createElement(TurnCard, turn))).not.toContain('上游端口超时')
  })

  it('keeps commentary folded at human, auth, warning and error boundaries', () => {
    for (const role of ['user', 'auth-request', 'warning', 'error'] as const) {
      const boundary: Message = { id: 'boundary', role, content: '下一条消息', timestamp: 5 }
      const turns = groupMessagesByTurn([human, thinking, boundary])
      expect((turns[1] as AssistantTurn).response).toBeUndefined()
      expect((turns[1] as AssistantTurn).activities[0]?.content).toBe(thinking.content)
      expect(turns).toHaveLength(3)
    }
  })

  it('preserves human quotations and hides hidden internal deliveries', () => {
    const quoted = { ...peer, content: '引用：\n' + peer.content }
    expect(groupMessagesByTurn([quoted])[0]?.type).toBe('user')
    expect(groupMessagesByTurn([{ ...peer, hidden: true }])).toEqual([])
  })

  it('folds local collaboration and cross-server relay communication too', () => {
    for (const header of [
      '[Collaboration request group-1 from primary]\n\n',
      '[Collaboration report group-1 from 诊断助手]\n\n',
      '[Collaboration report from member member-1]\nReply using the group member ID, not a session ID.\n\n',
    ]) {
      const message = { ...peer, content: header + '内部协作内容' }
      const turn = groupMessagesByTurn([human, thinking, message, answer])[1] as AssistantTurn
      expect(turn.activities[1]?.type).toBe('agent-message')
      expect(render(React.createElement(TurnCard, turn))).not.toContain('内部协作内容')
      expect(render(React.createElement(TurnCard, { ...turn, isExpanded: true }))).toContain('内部协作内容')
    }
  })
})

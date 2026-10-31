import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { UserMessageBubble, type UserMessageBubbleProps } from '../UserMessageBubble'

const i18n = createInstance()
await i18n.init({ lng: 'en', resources: { en: { translation: {} } }, initImmediate: false })
function render(props: UserMessageBubbleProps) {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}><UserMessageBubble {...props} /></I18nextProvider>)
}

describe('user message display', () => {
  const header = '[Message from session "261020-calm-dune" (币安 MCP 功能进度检查)]\nUse send_agent_message with sessionId "261020-calm-dune" to reply.\n\n---\n\n'
  it('renders peer messages as a separate card with routing metadata collapsed', () => {
    const html = render({ content: header + '**已读取当前稿**，继续补齐故障用例。' })
    expect(html).toContain('data-agent-message')
    expect(html).not.toContain('data-theme-bubble="user"')
    expect(html).toContain('币安 MCP 功能进度检查')
    expect(html).toMatch(/<strong\b[^>]*>已读取当前稿<\/strong>/)
    expect(html.indexOf('Use send_agent_message')).toBeGreaterThan(html.indexOf('<details'))
    expect(html).not.toContain('<details open')
  })
  it('preserves attachments, queued feedback and body badge positions on incoming agent messages', () => {
    const html = render({ content: header + '查看 /compact', isQueued: true,
      badges: [{ type: 'command', label: 'Compact', rawText: '/compact', start: header.length + 3, end: header.length + 11 }],
      attachments: [{ id: 'image', type: 'image', name: 'chart.png', mimeType: 'image/png', size: 10, storedPath: '/chart.png', thumbnailBase64: 'preview' }] })
    expect(html).toContain('data-agent-message')
    expect(html).toContain('data-message-image')
    expect(html).toContain('role="status"')
    expect(html).toContain('data-message-command')
    expect(html).toContain('Compact')
    expect(html).not.toContain('查看 /compact')
  })
  it('escapes sender names and keeps header-like ordinary messages in user bubbles', () => {
    const html = render({ content: header.replace('币安 MCP 功能进度检查', '<img src=x onerror=alert(1)>') + '正文' })
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img src=x')
    expect(render({ content: '引用：\n' + header + '正文' })).toContain('data-theme-bubble="user"')
  })
  it('omits blank messages entirely', () => {
    expect(render({ content: ' \n ' })).toBe('')
  })
  it('keeps image previews without adding an empty text bubble', () => {
    const html = render({ content: '', attachments: [{ id: 'image', type: 'image', name: 'chart.png', mimeType: 'image/png', size: 10, storedPath: '/chart.png', thumbnailBase64: 'preview' }] })
    expect(html).toContain('data-message-image')
    expect(html).toContain('data:image/png;base64,preview')
    expect(html).not.toContain('data-theme-bubble="user"')
  })
  it('keeps queue feedback on a message without text', () => {
    expect(render({ content: '', isQueued: true })).toContain('role="status"')
  })
  it('renders the compact command label with its own text color', () => {
    const html = render({ content: '/compact', badges: [{ type: 'command', label: 'Compact', rawText: '/compact', start: 0, end: 8 }] })
    expect(html).toContain('data-message-command')
    expect(html).toContain('text-foreground')
    expect(html).toContain('Compact')
  })
})

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

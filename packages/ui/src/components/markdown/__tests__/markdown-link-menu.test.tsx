import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { PlatformProvider } from '../../../context/PlatformContext'
import { MarkdownLink } from '../MarkdownLink'

const i18n = createInstance()
await i18n.init({ lng: 'en', resources: { en: { translation: {} } }, initImmediate: false })

function render(href?: string, text = 'Download', reveal = true) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <PlatformProvider actions={reveal ? { onRevealInFinder: () => {} } : {}}>
        <MarkdownLink href={href}>{text}</MarkdownLink>
      </PlatformProvider>
    </I18nextProvider>,
  )
}

describe('Markdown file link context menus', () => {
  it('adds a context menu to ZIP, CSV, JSON and image file links', () => {
    for (const extension of ['zip', 'csv', 'json', 'png']) {
      expect(render(`C:/Downloads/catalog.${extension}`)).toContain('data-state="closed"')
    }
  })

  it('handles encoded file URLs, UNC paths and relative files', () => {
    for (const target of ['file:///C:/My%20Files/catalog.zip', '\\\\server\\share\\catalog.csv', './catalog/index.json']) {
      expect(render(target)).toContain('data-state="closed"')
    }
    expect(render('file:///C:/My%20Files/catalog.zip')).not.toContain('href=')
  })

  it('allows copying even when revealing files is unavailable', () => {
    expect(render('/tmp/catalog.json', 'Catalog', false)).toContain('data-state="closed"')
  })

  it('handles a file path used as text in an empty-href anchor', () => {
    expect(render('', 'C:/Downloads/catalog.zip')).toContain('data-state="closed"')
  })

  it('preserves ordinary URL anchors without the file menu', () => {
    const html = render('https://example.com/catalog.zip')
    expect(html).toContain('href="https://example.com/catalog.zip"')
    expect(html).not.toContain('data-state=')
    expect(render(undefined, '')).not.toContain('data-state=')
  })

  it('does not expose unsafe schemes in DOM hrefs or give them file actions', () => {
    const html = render('javascript:alert(1)')
    expect(html).not.toContain('href=')
    expect(html).not.toContain('data-state=')
  })
})
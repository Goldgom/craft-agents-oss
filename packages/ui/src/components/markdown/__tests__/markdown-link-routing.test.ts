import { describe, it, expect } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { classifyMarkdownLinkTarget, resolveMarkdownLinkTarget } from '../link-target'
import { markdownUrlTransform } from '../url-transform'
import { preprocessLinks } from '../linkify'

describe('resolveMarkdownLinkTarget', () => {
  it('recognizes Windows absolute paths regardless of extension or preview support', () => {
    for (const path of ['E:/AIProjects/sa/run-instruct-v2/heads.pt', 'E:\\Models\\weights.safetensors', '\\\\server\\share\\model.ckpt', 'E:/Models/LICENSE', 'E:/Models/']) {
      expect(resolveMarkdownLinkTarget(path)).toEqual({ kind: 'file', path })
      expect(resolveMarkdownLinkTarget(path.replace(/\\/g, '%5C'))).toEqual({ kind: 'file', path })
    }
  })

  it('preserves Windows drive and UNC paths, including encoded backslashes', () => {
    for (const path of ['E:/Projects/report.md', 'E:\\Projects\\report.md', '\\\\server\\share\\report.pdf', 'E:/My Documents/report.md']) {
      expect(resolveMarkdownLinkTarget(path)).toEqual({ kind: 'file', path })
      expect(resolveMarkdownLinkTarget(path.replace(/\\/g, '%5C'))).toEqual({ kind: 'file', path })
    }
  })
  it('resolves absolute unix file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('/Users/balintorosz/.tokenbird/sessions/abc/image.jpg')).toEqual({
      kind: 'file',
      path: '/Users/balintorosz/.tokenbird/sessions/abc/image.jpg',
    })
  })

  it('resolves parent-relative file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('../downloads/assets/screenshot.png')).toEqual({
      kind: 'file',
      path: '../downloads/assets/screenshot.png',
    })
  })

  it('resolves repo-relative file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('apps/electron/resources/docs/browser-tools.md')).toEqual({
      kind: 'file',
      path: 'apps/electron/resources/docs/browser-tools.md',
    })
  })

  it('resolves unix file URLs as file targets', () => {
    expect(resolveMarkdownLinkTarget('file:///Users/tester/report.xlsx')).toEqual({
      kind: 'file',
      path: '/Users/tester/report.xlsx',
    })
  })

  it('decodes percent-encoded unix file URLs', () => {
    expect(resolveMarkdownLinkTarget('file:///Users/tester/report%20final.pdf')).toEqual({
      kind: 'file',
      path: '/Users/tester/report final.pdf',
    })
  })

  it('decodes a percent-encoded space in a BARE local file path (#944)', () => {
    expect(resolveMarkdownLinkTarget('/Users/tester/My%20Docs/report%20final.pptx')).toEqual({
      kind: 'file',
      path: '/Users/tester/My Docs/report final.pptx',
    })
  })

  it('leaves a bare path with an invalid percent-sequence untouched (#944)', () => {
    expect(resolveMarkdownLinkTarget('/Users/tester/100%done/notes.md')).toEqual({
      kind: 'file',
      path: '/Users/tester/100%done/notes.md',
    })
  })

  it('normalizes windows drive-letter file URLs to local paths', () => {
    expect(resolveMarkdownLinkTarget('file:///C:/Users/Tester/Deck.pptx')).toEqual({
      kind: 'file',
      path: 'C:/Users/Tester/Deck.pptx',
    })
  })

  it('resolves https links as url targets', () => {
    expect(resolveMarkdownLinkTarget('https://example.com/image.jpg')).toEqual({
      kind: 'url',
      url: 'https://example.com/image.jpg',
    })
  })

  it('resolves mailto links as url targets', () => {
    expect(resolveMarkdownLinkTarget('mailto:test@example.com')).toEqual({
      kind: 'url',
      url: 'mailto:test@example.com',
    })
  })
})

describe('markdownUrlTransform', () => {
  it('preserves dangerous anchor hrefs for custom click routing', () => {
    const anchorNode = { tagName: 'a' }
    expect(markdownUrlTransform('file:///tmp/test.md', 'href', anchorNode as never)).toBe('file:///tmp/test.md')
    expect(markdownUrlTransform('javascript:alert(1)', 'href', anchorNode as never)).toBe('javascript:alert(1)')
  })

  it('still sanitizes dangerous non-anchor URL attributes', () => {
    const imageNode = { tagName: 'img' }
    expect(markdownUrlTransform('javascript:alert(1)', 'src', imageNode as never)).toBe('')
  })

  it('keeps safe anchor hrefs unchanged', () => {
    const anchorNode = { tagName: 'a' }
    expect(markdownUrlTransform('https://example.com', 'href', anchorNode as never)).toBe('https://example.com')
  })
})

describe('ReactMarkdown anchor rendering with markdownUrlTransform', () => {
  function parsedFileTarget(markdown: string) {
    let target: ReturnType<typeof resolveMarkdownLinkTarget> | undefined
    renderToStaticMarkup(React.createElement(ReactMarkdown, {
      urlTransform: markdownUrlTransform,
      components: {
        a: ({ href, children }) => {
          target = resolveMarkdownLinkTarget(href ?? '')
          return React.createElement('span', null, children)
        },
      },
      children: preprocessLinks(markdown),
    }))
    return target
  }

  it('preserves the hidden workspace separator in a live Windows report link', () => {
    const path = String.raw`C:\Users\Goldgom\.tokenbird\workspaces\my-workspace\sessions\261008-gentle-crow\data\BugClose实验报告_图书馆全新数据版.docx`
    expect(parsedFileTarget(`📄 **[下载《BugClose 实验报告—图书馆全新数据版》](${path})**`)).toEqual({ kind: 'file', path })
  })

  it('resolves live and reloaded history paths to the same file', () => {
    const livePath = String.raw`C:\Users\Goldgom\.tokenbird\workspaces\my-workspace\sessions\261008-gentle-crow\data\report.docx`
    // JSONL expansion normalizes the session directory to forward slashes.
    const historyPath = livePath.replace(/\\/g, '/')
    const live = parsedFileTarget(`[report](${livePath})`)
    const history = parsedFileTarget(`[report](${historyPath})`)
    expect(live?.kind).toBe('file')
    expect(history?.kind).toBe('file')
    if (live?.kind === 'file' && history?.kind === 'file') {
      expect(live.path.replace(/\\/g, '/')).toBe(history.path)
    }
  })

  it('preserves UNC shares and punctuation in Windows directory names', () => {
    for (const path of [
      String.raw`\\server\share\.outputs\report.docx`,
      String.raw`C:\reports\(draft)\_v2\[final]\report.docx`,
      String.raw`C:/Users/Goldgom/.tokenbird/sessions/abc\data\.outputs\report.docx`,
    ]) {
      expect(parsedFileTarget(`[report](${path})`)).toEqual({ kind: 'file', path })
    }
  })

  it('preserves angle-bracket destinations, spaces and link titles', () => {
    const path = String.raw`C:\My Reports\.outputs\report (final).docx`
    expect(parsedFileTarget(`[report](<${path}> "Download report")`)).toEqual({ kind: 'file', path })
  })

  it('protects Windows reference definitions without nesting auto-links', () => {
    const path = String.raw`C:\Users\Goldgom\.tokenbird\data\report.docx`
    expect(parsedFileTarget(`[report][artifact]\n\n[artifact]: ${path} "Download report"`)).toEqual({ kind: 'file', path })
  })

  it('does not re-encode an already protected file link', () => {
    const path = String.raw`C:\Users\Goldgom\.tokenbird\data\report.docx`
    const once = preprocessLinks(`[report](${path})`)
    expect(preprocessLinks(once)).toBe(once)
    expect(parsedFileTarget(once)).toEqual({ kind: 'file', path })
  })

  it('keeps Windows links in inline and fenced code verbatim', () => {
    const link = String.raw`[report](C:\Users\Goldgom\.tokenbird\report.docx)`
    for (const input of ['`' + link + '`', '```md\n' + link + '\n```']) {
      expect(preprocessLinks(input)).toBe(input)
      expect(parsedFileTarget(input)).toBeUndefined()
    }
  })

  function render(markdown: string): string {
    return renderToStaticMarkup(React.createElement(ReactMarkdown, {
      urlTransform: markdownUrlTransform,
      components: {
        a: ({ href, children }) => React.createElement('a', {
          href: href ? defaultUrlTransform(href) || undefined : undefined,
          'data-raw-href': href,
        }, children),
      },
      children: markdown,
    }))
  }

  it('lets file links reach the custom anchor while keeping the DOM href sanitized', () => {
    const html = render('[report](file:///Users/tester/report.pdf)')
    expect(html).toContain('data-raw-href="file:///Users/tester/report.pdf"')
    expect(html).not.toContain('<a href="file:///Users/tester/report.pdf"')
  })

  it('lets javascript links reach the custom anchor while keeping the DOM href sanitized', () => {
    const html = render('[boom](javascript:alert(1))')
    expect(html).toContain('data-raw-href="javascript:alert(1)"')
    expect(html).not.toContain('<a href="javascript:alert')
  })

  it('keeps safe web links in the DOM href for normal browser affordances', () => {
    const html = render('[site](https://example.com/path)')
    expect(html).toContain('href="https://example.com/path"')
  })
})

describe('classifyMarkdownLinkTarget', () => {
  it('classifies absolute unix file paths as file', () => {
    expect(classifyMarkdownLinkTarget('/Users/balintorosz/.tokenbird/sessions/abc/image.jpg')).toBe('file')
  })

  it('classifies file URLs as file', () => {
    expect(classifyMarkdownLinkTarget('file:///Users/tester/report.xlsx')).toBe('file')
  })

  it('classifies https links as url', () => {
    expect(classifyMarkdownLinkTarget('https://example.com/image.jpg')).toBe('url')
  })

  it('classifies mailto links as url', () => {
    expect(classifyMarkdownLinkTarget('mailto:test@example.com')).toBe('url')
  })
})

import { describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { classifyFile } from '../../../../../../packages/ui/src/lib/file-classification'
mock.module('@craft-agent/ui', () => ({ classifyFile }))
mock.module('../../../../../../packages/ui/src/components/markdown', () => ({ Markdown: () => null }))
mock.module('../../../../../../packages/ui/src/components/overlay/AnnotatableMarkdownDocument', () => ({ AnnotatableMarkdownDocument: () => null }))
mock.module('../../../../../../packages/ui/src/components/overlay/FullscreenOverlayBase', () => ({
  FullscreenOverlayBase: ({ error }: { error?: { label: string; message: string } }) =>
    React.createElement('div', { role: 'alert' }, error?.label, error?.message),
}))
const { readTextFilePreview } = await import('../useLinkInterceptor')
const { DocumentFormattedMarkdownOverlay } = await import('../../../../../../packages/ui/src/components/overlay/DocumentFormattedMarkdownOverlay')

describe('text file preview reads', () => {
  it('keeps a failed read distinct from a successfully read empty Markdown file', async () => {
    const path = 'E:/project/missing.md'
    const failed = await readTextFilePreview('markdown', path, async requested => {
      expect(requested).toBe(path)
      throw new Error('File not found: ' + requested)
    })
    expect(failed.filePath).toBe(path)
    expect('error' in failed && failed.error).toContain('File not found')
    const html = renderToStaticMarkup(React.createElement(DocumentFormattedMarkdownOverlay, {
      isOpen: true, onClose() {}, content: '', filePath: path,
      error: 'error' in failed ? failed.error : undefined, errorLabel: 'Read Failed',
    }))
    expect(html).toContain('Read Failed')
    expect(html).toContain('File not found')
    expect(html).not.toContain('Write Failed')
    const empty = await readTextFilePreview('markdown', path, async () => '')
    expect('content' in empty && empty.content).toBe('')
    expect('error' in empty && empty.error).toBeFalsy()
  })

  it('loads the content from the exact resolved filename', async () => {
    const path = 'E:/AIProjects/sa/qwen4b-decision-pilot/cuda-readiness-followup.md'
    const state = await readTextFilePreview('markdown', path, async requested => {
      if (requested !== path) throw new Error('Wrong project file')
      return '# CUDA readiness\nVerified report'
    })
    expect('content' in state && state.content).toContain('Verified report')
    expect('error' in state && state.error).toBeFalsy()
  })
})

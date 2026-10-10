import { describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'

const { PlatformProvider, usePlatform } = await import('@craft-agent/ui/context')
const { MarkdownLink } = await import('../../../../../../packages/ui/src/components/markdown/MarkdownLink')
const { SuperAgentFileContext } = await import('./SuperAgentFileContext')
const i18n = createInstance()
await i18n.init({ lng: 'en', resources: { en: { translation: {} } }, initAsync: false })

function find(node: React.ReactNode, predicate: (element: React.ReactElement<any>) => boolean): React.ReactElement<any> | undefined {
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return undefined
  if (predicate(node)) return node
  for (const child of React.Children.toArray(node.props.children)) {
    const match = find(child, predicate)
    if (match) return match
  }
}

function render(href: string, workingDirectory = 'E:/AIProjects/sa') {
  const onOpenFile = mock(() => {})
  const onOpenUrl = mock(() => {})
  const onCopyToClipboard = mock(async () => {})
  const onRevealInFinder = mock(() => {})
  const onReadFile = mock(async (path: string) => path)
  let tree: React.ReactNode
  let scoped: ReturnType<typeof usePlatform>
  function Capture() {
    scoped = usePlatform()
    tree = MarkdownLink({ href, children: 'CUDA report' })
    return tree
  }
  renderToStaticMarkup(React.createElement(I18nextProvider, { i18n },
    React.createElement(PlatformProvider, { actions: { onOpenFile, onOpenUrl, onCopyToClipboard, onRevealInFinder, onReadFile },
      children: React.createElement(SuperAgentFileContext, { workingDirectory, children: React.createElement(Capture) }) })))
  return { tree: tree!, scoped: scoped!, onOpenFile, onOpenUrl, onCopyToClipboard, onRevealInFinder, onReadFile }
}

describe('Super Agent environment file links', () => {
  it('clicks the reported relative CUDA link using the team project directory', () => {
    const view = render('qwen4b-decision-pilot/cuda-readiness-followup.md')
    find(view.tree, element => element.type === 'a')!.props.onClick({ preventDefault() {} })
    expect(view.onOpenFile).toHaveBeenCalledWith('E:/AIProjects/sa/qwen4b-decision-pilot/cuda-readiness-followup.md')
    expect(view.onOpenUrl).not.toHaveBeenCalled()
  })

  it('copies and reveals the resolved file, and scopes file-backed reads', async () => {
    const relative = 'qwen4b-decision-pilot/cuda-readiness-followup.md'
    const path = `E:/AIProjects/sa/${relative}`
    const view = render(relative)
    const select = (label: string) => find(view.tree, element => element.props.onSelect
      && React.Children.toArray(element.props.children).includes(label))!
    select('common.openFileLocation').props.onSelect()
    select('common.copyAddress').props.onSelect()
    expect(view.onRevealInFinder).toHaveBeenCalledWith(path)
    expect(view.onCopyToClipboard).toHaveBeenCalledWith(path)
    expect(await view.scoped.onReadFile!(relative)).toBe(path)
  })

  it('preserves Windows, UNC and home paths and sends web links to the URL handler', () => {
    for (const path of ['E:/other/report.md', 'E:\\other\\report.md', '\\\\server\\share\\report.md', '~/report.md']) {
      const view = render(path)
      find(view.tree, element => element.type === 'a')!.props.onClick({ preventDefault() {} })
      expect(view.onOpenFile).toHaveBeenCalledWith(path)
    }
    const view = render('https://example.com/report.md')
    find(view.tree, element => element.type === 'a')!.props.onClick({ preventDefault() {} })
    expect(view.onOpenUrl).toHaveBeenCalledWith('https://example.com/report.md')
    expect(view.onOpenFile).not.toHaveBeenCalled()
  })

  it('uses the current environment and decodes destinations before resolving', () => {
    const view = render('./My%20Reports/report.md', 'D:\\Current Project\\')
    find(view.tree, element => element.type === 'a')!.props.onClick({ preventDefault() {} })
    expect(view.onOpenFile).toHaveBeenCalledWith('D:\\Current Project/My Reports/report.md')
  })
})

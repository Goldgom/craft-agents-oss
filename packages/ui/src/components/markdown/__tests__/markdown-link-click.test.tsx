import { describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { PlatformProvider, type PlatformActions } from '../../../context/PlatformContext'
import { MarkdownLink } from '../MarkdownLink'
import { classifyFile } from '../../../lib/file-classification'

const i18n = createInstance()
await i18n.init({ lng: 'en', resources: { en: { translation: {} } }, initImmediate: false })

type LinkProps = React.ComponentProps<typeof MarkdownLink>
type AnchorProps = React.ComponentProps<'a'>

function findAnchor(node: React.ReactNode): React.ReactElement<AnchorProps> | undefined {
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return undefined
  if (node.type === 'a') return node as React.ReactElement<AnchorProps>
  for (const child of React.Children.toArray(node.props.children)) {
    const anchor = findAnchor(child)
    if (anchor) return anchor
  }
  return undefined
}

function clickLink(props: LinkProps, actions: PlatformActions = {}) {
  let anchor: React.ReactElement<AnchorProps> | undefined
  function CaptureLink() {
    const link = MarkdownLink(props)
    anchor = findAnchor(link)
    return link
  }
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <PlatformProvider actions={actions}><CaptureLink /></PlatformProvider>
    </I18nextProvider>,
  )
  expect(anchor?.props.onClick).toBeDefined()
  const preventDefault = mock(() => {})
  anchor!.props.onClick!({ preventDefault } as unknown as React.MouseEvent<HTMLAnchorElement>)
  expect(preventDefault).toHaveBeenCalledTimes(1)
}

describe('Markdown link click dispatch', () => {
  it('opens the Super Agent training report through the platform preview flow without explicit callbacks', () => {
    const path = 'E:/AIProjects/sa/qwen4b-decision-pilot/training-report.md'
    const onOpenFile = mock(() => {})
    const onOpenUrl = mock(() => {})
    clickLink({ href: path, children: '训练报告' }, { onOpenFile, onOpenUrl })
    expect(onOpenFile).toHaveBeenCalledWith(path)
    expect(onOpenFile).toHaveBeenCalledTimes(1)
    expect(onOpenUrl).not.toHaveBeenCalled()
    expect(classifyFile(path)).toEqual({ type: 'markdown', canPreview: true })
  })

  it('routes a checkpoint as a file rather than a URL or text preview', () => {
    const path = 'E:/AIProjects/sa/qwen4b-decision-pilot/run-instruct-v2/heads.pt'
    const onOpenFile = mock(() => {})
    const onOpenUrl = mock(() => {})
    clickLink({ href: path, children: '决策头 checkpoint' }, { onOpenFile, onOpenUrl })
    expect(onOpenFile).toHaveBeenCalledWith(path)
    expect(onOpenUrl).not.toHaveBeenCalled()
    expect(classifyFile(path)).toEqual({ type: null, canPreview: false })
  })

  it('decodes file URLs before opening them', () => {
    const onOpenFile = mock(() => {})
    clickLink({ href: 'file:///E:/My%20Reports/report.md' }, { onOpenFile })
    expect(onOpenFile).toHaveBeenCalledWith('E:/My Reports/report.md')
  })

  it('opens web links through the platform URL handler', () => {
    const onOpenFile = mock(() => {})
    const onOpenUrl = mock(() => {})
    clickLink({ href: 'https://example.com/report' }, { onOpenFile, onOpenUrl })
    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com/report')
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('preserves explicit file and URL callbacks instead of opening twice', () => {
    const onOpenFile = mock(() => {})
    const onOpenUrl = mock(() => {})
    const onFileClick = mock(() => {})
    const onUrlClick = mock(() => {})
    clickLink({ href: 'E:/report.md', onFileClick }, { onOpenFile, onOpenUrl })
    clickLink({ href: 'https://example.com', onUrlClick }, { onOpenFile, onOpenUrl })
    expect(onFileClick).toHaveBeenCalledWith('E:/report.md')
    expect(onUrlClick).toHaveBeenCalledWith('https://example.com')
    expect(onOpenFile).not.toHaveBeenCalled()
    expect(onOpenUrl).not.toHaveBeenCalled()
  })

  it('uses a file path in the anchor text when href is empty', () => {
    const onOpenFile = mock(() => {})
    clickLink({ href: '', children: 'E:/report.md' }, { onOpenFile })
    expect(onOpenFile).toHaveBeenCalledWith('E:/report.md')
  })

  it('does not dispatch an empty anchor and tolerates platforms without open actions', () => {
    const onOpenFile = mock(() => {})
    const onOpenUrl = mock(() => {})
    clickLink({}, { onOpenFile, onOpenUrl })
    expect(onOpenFile).not.toHaveBeenCalled()
    expect(onOpenUrl).not.toHaveBeenCalled()
    expect(() => clickLink({ href: 'E:/report.md' })).not.toThrow()
  })
})

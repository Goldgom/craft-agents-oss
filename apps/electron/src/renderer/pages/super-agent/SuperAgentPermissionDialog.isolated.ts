import { describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import type { AppShellContextType } from '../../context/AppShellContext'
import type { PermissionRequest } from '../../../shared/types'

mock.module('@/components/markdown', () => ({ Markdown: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children) }))
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

const { AppShellProvider } = await import('../../context/AppShellContext')
const { SuperAgentPermissionDialog } = await import('./SuperAgentPermissionDialog')
const { ApprovalCard } = await import('./SuperAgentConversation')
const { Dialog } = await import('../../components/ui/dialog')
const i18n = createInstance()
await i18n.init({ lng: 'zh', resources: { zh: { translation: {} } }, initAsync: false })

function find(node: React.ReactNode, type: unknown): React.ReactElement<Record<string, unknown>> | undefined {
  if (!React.isValidElement<Record<string, unknown>>(node)) return
  if (node.type === type) return node
  for (const child of React.Children.toArray(node.props.children as React.ReactNode)) {
    const match = find(child, type)
    if (match) return match
  }
}
function render(pendingPermissions: Map<string, PermissionRequest[]>) {
  const respond = mock(async () => {})
  let tree: React.ReactNode
  function Capture() { tree = SuperAgentPermissionDialog(); return tree }
  const value = { pendingPermissions, onRespondToPermission: respond } as unknown as AppShellContextType
  renderToStaticMarkup(React.createElement(I18nextProvider, { i18n },
    React.createElement(AppShellProvider, { value, children: React.createElement(Capture) })))
  return { tree, respond }
}
const request = (sessionId: string, requestId: string): PermissionRequest => ({ sessionId, requestId, toolName: 'Read',
  description: 'Read outside project', policyScope: { kind: 'file_read', toolName: 'Read', target: 'E:/reports/report.md',
    operation: '{"file_path":"E:/reports/report.md"}', boundary: 'outside-environment', expiresAt: Date.now() + 60_000 } })

describe('global permission dialog', () => {
  it('does not open without a live pending request', () => {
    expect(render(new Map()).tree).toBeNull()
  })
  it.each([true, false])('asks for a background session and routes decision %s to the original request', allowed => {
    const first = request('background-session', 'first')
    const second = request('another-session', 'second')
    const { tree, respond } = render(new Map([[first.sessionId, [first]], [second.sessionId, [second]]]))
    expect(find(tree, Dialog)?.props.open).toBe(true)
    const card = find(tree, ApprovalCard)!
    expect(card.props.request).toBe(first)
    expect(card.props.pending).toBe(false)
    ;(card.props.onRespond as (allowed: boolean) => void)(allowed)
    expect(respond).toHaveBeenCalledWith('background-session', 'first', allowed, false)
    expect(respond).toHaveBeenCalledTimes(1)
  })
  it('closing the notice leaves the suspended request undecided', () => {
    const pending = request('worker', 'close-only')
    const { tree, respond } = render(new Map([[pending.sessionId, [pending]]]))
    ;(find(tree, Dialog)!.props.onOpenChange as (open: boolean) => void)(false)
    expect(respond).not.toHaveBeenCalled()
  })
})

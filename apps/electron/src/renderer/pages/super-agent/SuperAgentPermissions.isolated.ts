import { describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { emptySuperAgentState, superAgentPermissionEnvironmentKey, type SuperAgentConfig, type SuperAgentSnapshot } from '@craft-agent/shared/super-agent'
import type { AppShellContextType } from '../../context/AppShellContext'

mock.module('@/components/markdown', () => ({ Markdown: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children) }))
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

const { AppShellProvider } = await import('../../context/AppShellContext')
const { SuperAgentPermissions } = await import('./SuperAgentPermissions')
const { ApprovalCard } = await import('./SuperAgentConversation')
const { createConfig } = await import('./super-agent-ui')
const i18n = createInstance()
await i18n.init({ lng: 'zh', resources: { zh: { translation: {} } }, initAsync: false })

function fixture(): SuperAgentSnapshot & { config: SuperAgentConfig } {
  const config = createConfig([], key => key)
  const worker = config.nodes.find(node => node.role === 'worker')!
  return { config, state: { ...emptySuperAgentState(), nodes: [{ nodeId: worker.id, status: 'working', sessionId: 'session' }] },
    environment: { available: true, isolation: 'host-folder', detail: '' }, permissionRequests: [{ id: 'request', nodeId: worker.id,
      coordinatorId: config.nodes.find(node => node.role === 'coordinator')!.id, sessionId: 'session', toolName: 'Read', description: 'Read protected report',
      status: 'pending', createdAt: 1, scope: { kind: 'file_read', target: 'E:/reports/report.md', toolName: 'Read', operation: '{"file_path":"E:/reports/report.md"}', boundary: 'outside-environment', expiresAt: 100_000 } }] }
}

function findElement(node: React.ReactNode, predicate: (element: React.ReactElement<Record<string, unknown>>) => boolean): React.ReactElement<Record<string, unknown>> | undefined {
  if (!React.isValidElement<Record<string, unknown>>(node)) return undefined
  if (predicate(node)) return node
  for (const child of React.Children.toArray(node.props.children as React.ReactNode)) {
    const element = findElement(child, predicate)
    if (element) return element
  }
  return undefined
}

function render(snapshot = fixture(), busy = false) {
  const onCommand = mock(async () => {})
  let tree: React.ReactNode
  function CapturePermissions() {
    tree = SuperAgentPermissions({ snapshot, busy, onCommand })
    return tree
  }
  const value = { pendingPermissions: new Map(), onRespondToPermission: async () => {} } as unknown as AppShellContextType
  const html = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n },
    React.createElement(AppShellProvider, { value, children: React.createElement(CapturePermissions) })))
  return { html, tree, onCommand }
}

describe('Super Agent permission management UI', () => {
  it('renders the shared management view with temporary and explicit team approvals', () => {
    const { html } = render()
    expect(html).toContain('权限管理')
    expect(html).toContain('Read protected report')
    expect(html).toContain('全队记住此操作</button>')
    expect(html).toContain('授权此操作（本轮）</button>')
    expect(html).toContain('完全控制已开启')
  })

  it('dispatches the explicit shared approval without changing ordinary approval defaults', () => {
    const { tree, onCommand } = render()
    const card = findElement(tree, element => element.type === ApprovalCard)!
    const remember = card.props.onRemember as () => void
    remember()
    expect(onCommand).toHaveBeenCalledWith({ type: 'permission-response', requestId: 'request', allowed: true, remember: true })
    const ordinary = render()
    const ordinaryCard = findElement(ordinary.tree, element => element.type === ApprovalCard)!
    const approve = ordinaryCard.props.onRespond as (allowed: boolean) => void
    approve(true)
    expect(ordinary.onCommand).toHaveBeenCalledWith({ type: 'permission-response', requestId: 'request', allowed: true })
  })

  it('does not offer remembered approvals for browser operations without stable targets', () => {
    const snapshot = fixture()
    snapshot.permissionRequests![0]!.scope!.kind = 'browser'
    snapshot.permissionRequests![0]!.scope!.target = 'browser_tool'
    const { html, tree } = render(snapshot)
    expect(html).not.toContain('全队记住此操作</button>')
    expect(findElement(tree, element => element.type === ApprovalCard)!.props.onRemember).toBeUndefined()
  })

  it('renders a saved permission and dispatches its revocation', () => {
    const snapshot = fixture()
    const { expiresAt, ...scope } = snapshot.permissionRequests![0]!.scope!
    snapshot.state.permissionGrants = [{ id: 'grant', nodeId: snapshot.permissionRequests![0]!.nodeId, description: 'Shared protected report',
      scope, environmentKey: superAgentPermissionEnvironmentKey(snapshot.config.environment), createdAt: 1 }]
    const { html, tree, onCommand } = render(snapshot)
    expect(html).toContain('Shared protected report')
    expect(html).toContain('撤销共享授权</button>')
    const button = findElement(tree, element => element.props.children === '撤销共享授权')!
    const revoke = button.props.onClick as () => void
    revoke()
    expect(onCommand).toHaveBeenCalledWith({ type: 'permission-revoke', grantId: 'grant' })
  })
})

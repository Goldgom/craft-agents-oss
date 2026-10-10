import { describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import type { SuperAgentNodeRuntime } from '@craft-agent/shared/super-agent'
import { SuperAgentNodeRecovery } from './SuperAgentNodeRecovery'

const i18n = createInstance()
await i18n.init({ lng: 'zh', resources: { zh: { translation: {} } }, initAsync: false })

function findButton(node: React.ReactNode): React.ReactElement<Record<string, unknown>> | undefined {
  if (!React.isValidElement<Record<string, unknown>>(node)) return undefined
  if (typeof node.props.onClick === 'function') return node
  for (const child of React.Children.toArray(node.props.children as React.ReactNode)) {
    const found = findButton(child)
    if (found) return found
  }
  return undefined
}

function render(runtime: SuperAgentNodeRuntime, busy = false) {
  const onCommand = mock(async () => {})
  let tree: React.ReactNode
  function Capture() {
    tree = SuperAgentNodeRecovery({ runtime, busy, onCommand })
    return tree
  }
  const html = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n }, React.createElement(Capture)))
  return { html, tree, onCommand }
}

describe('Super Agent node recovery controls', () => {
  it('shows retry time, deadline and dispatches retry for the exact node', () => {
    const result = render({ nodeId: 'worker', status: 'recovering', retryAttempt: 2, retryAt: 2000, retryDeadline: 600000 })
    expect(result.html).toContain('立即重试')
    expect(result.html).toContain('下次尝试')
    expect(result.html).toContain('自动恢复截止')
    expect(result.html).toContain('第 2 次恢复')
    const button = findButton(result.tree)!
    const click = button.props.onClick as () => void
    click()
    expect(result.onCommand).toHaveBeenCalledWith({ type: 'node-refresh', nodeId: 'worker' })
  })

  it('offers refresh for coordinator errors and explains nonreplay safety', () => {
    const result = render({ nodeId: 'main', status: 'error' })
    expect(result.html).toContain('刷新节点')
    expect(result.html).toContain('不自动重跑')
    const click = findButton(result.tree)!.props.onClick as () => void
    click()
    expect(result.onCommand).toHaveBeenCalledWith({ type: 'node-refresh', nodeId: 'main' })
  })

  it('disables refresh during mutation and hides it for healthy or busy nodes', () => {
    const result = render({ nodeId: 'worker', status: 'error' }, true)
    expect(findButton(result.tree)!.props.disabled).toBe(true)
    for (const status of ['idle', 'preparing', 'working'] as const) {
      expect(render({ nodeId: 'worker', status }).html).toBe('')
    }
  })
})

import { expect, test, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import type { SuperAgentRecoverySummary } from '@tokenbird/shared/super-agent'
import { SuperAgentWorkerRecovery } from './SuperAgentWorkerRecovery'

const i18n = createInstance()
await i18n.init({ lng: 'zh', resources: { zh: { translation: {} } }, initAsync: false })
const recovery: SuperAgentRecoverySummary = { id: 'restore-once', generation: 1, phase: 'blocked', reason: 'restart', sourceRevision: 2,
  createdAt: 1, updatedAt: 2, attempts: 1, pendingTaskIds: ['job'], unresolvedOperationIds: ['op_1'], error: 'Previous worker still active' }
function render(value?: SuperAgentRecoverySummary, suspended = false) {
  const onCommand = mock(async () => {})
  let tree: React.ReactElement<{ children: React.ReactNode }>
  function Capture() {
    tree = SuperAgentWorkerRecovery({ recovery: value, busy: false, suspended, onCommand })
    return tree
  }
  const html = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n }, React.createElement(Capture)))
  const button = React.Children.toArray(tree!.props.children).find(child => React.isValidElement<{ onClick?: unknown }>(child) && child.props.onClick) as React.ReactElement<{ onClick: () => void; disabled: boolean }>
  return { html, button, onCommand }
}

test('recovery retries the same record and explains resource verification without deleting work', () => {
  const result = render(recovery)
  expect(result.html).toContain('恢复任务')
  expect(result.html).toContain('1 项操作待核验')
  result.button.props.onClick()
  expect(result.onCommand).toHaveBeenCalledWith({ type: 'recover-workers', requestId: 'restore-once' })
})

test('ongoing recovery and explicit stop disable repeated dispatch', () => {
  expect(render({ ...recovery, phase: 'stopping' }).button.props.disabled).toBe(true)
  expect(render(undefined, true).button.props.disabled).toBe(true)
  expect(render().html).toContain('通信和任务板')
})

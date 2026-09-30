/**
 * Isolated in-process DOM tests for the real React dialog components.
 * No browser/network route is used. UI primitives, React state, and Radix
 * dismissal behavior are real; electronAPI, translations and toasts are mocks.
 *
 * Install an optional test-only DOM dependency outside the checkout:
 * npm_config_cache=/tmp/tokenbird-ui-test-tools/npm-cache npm install \
 *   --prefix /tmp/tokenbird-ui-test-tools --ignore-scripts happy-dom@20.8.3
 *
 * TOKENBIRD_TEST_DOM_MODULE=/tmp/tokenbird-ui-test-tools/node_modules/happy-dom/lib/index.js \
 *   bun test --tsconfig-override ./apps/electron/tsconfig.json ./scripts/tokenbird-ui-lifecycle.smoke.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

const domModule = process.env.TOKENBIRD_TEST_DOM_MODULE ?? '/tmp/tokenbird-ui-test-tools/node_modules/happy-dom/lib/index.js'
const { Window } = await import(domModule)
const dom = new Window({ url: 'http://tokenbird-dom.test', settings: {
  disableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true,
} })
// Bun 1.3's VM context does not expose these intrinsic constructors to
// happy-dom. Supply the normal ECMAScript constructors to this test window.
for (const name of ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError']) {
  if (!dom[name]) dom[name] = (globalThis as any)[name]
}
for (const name of ['window', 'document', 'navigator', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'DocumentFragment', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'CustomEvent', 'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  const value = name === 'window' ? dom : name === 'document' ? dom.document : dom[name]
  Object.defineProperty(globalThis, name, { value: typeof value === 'function' && /^[a-z]/.test(name) ? value.bind(dom) : value, configurable: true, writable: true })
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const t = (key: string, values?: any) => values?.count !== undefined ? `${key}:${values.count}` : key
const toast = { success: mock(() => {}), warning: mock(() => {}), error: mock(() => {}) }
const originalConsoleError = console.error
const consoleErrors = spyOn(console, 'error').mockImplementation((...args: any[]) => originalConsoleError(...args))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t }) }))
mock.module('sonner', () => ({ toast }))

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { act } = React
const { CollaborationDialog } = await import('../apps/electron/src/renderer/components/app-shell/CollaborationDialog')
const { McpManagementDialog } = await import('../apps/electron/src/renderer/components/app-shell/McpManagementDialog')
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
let api: any
let onOpenChange: ReturnType<typeof mock>
let onRefresh: ReturnType<typeof mock>
const primary = { id: 'primary', workspaceId: 'w1', name: 'Primary session' } as any
const secondary = { id: 'secondary', workspaceId: 'w1', name: 'Existing secondary' } as any
const otherSecondary = { id: 'secondary-other', workspaceId: 'w2', name: 'Other secondary' } as any
const workspaces = [{ id: 'w1', name: 'Workspace One' }, { id: 'w2', name: 'Workspace Two' }]
const sources = [{ config: { type: 'mcp', name: 'Existing', slug: 'existing', mcp: { authType: 'bearer' } } }] as any

function deferred<T = any>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush() { await act(async () => { await Promise.resolve(); await Bun.sleep(0) }) }
async function renderCollaboration(open = true) {
  await act(async () => { root.render(React.createElement(CollaborationDialog, { primary, open, onOpenChange })) })
  await flush()
}
async function renderMcp(open = true, workspaceId = 'w1') {
  await act(async () => { root.render(React.createElement(McpManagementDialog, { open, workspaceId, sources, onRefresh, onOpenChange })) })
  await flush()
}
function element<T extends Element = HTMLElement>(selector: string): T {
  const result = document.querySelector(selector)
  if (!result) throw new Error(`Missing element: ${selector}. Body: ${document.body.textContent}`)
  return result as T
}
function button(text: string): HTMLButtonElement {
  const result = Array.from(document.querySelectorAll('button')).find(x => x.textContent === text)
  if (!result) throw new Error(`Missing button: ${text}. Body: ${document.body.textContent}`)
  return result
}
async function click(target: Element) {
  await act(async () => { (target as HTMLElement).click() })
  await flush()
}
async function change(target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : target.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value)
    target.dispatchEvent(new Event(target.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
  await flush()
}
function field(label: string) { return element<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`) }
function serverSelect() { return element<HTMLSelectElement>('select') }
function workspaceSelect() { return document.querySelectorAll('select')[1] as HTMLSelectElement }
function body() { return document.body.textContent ?? '' }

beforeEach(async () => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  onOpenChange = mock(() => {})
  onRefresh = mock(async () => {})
  for (const value of Object.values(toast)) value.mockClear()
  api = {
    getRemoteServers: mock(async () => [
      { id: 'r1', name: 'Remote One', url: 'http://remote-one.test', hasToken: true },
      { id: 'r2', name: 'Remote Two', url: 'http://remote-two.test', hasToken: true },
    ]),
    getStartupContext: mock(async () => ({ mode: 'local' })),
    listCollaborationCandidates: mock(async () => [primary, secondary, otherSecondary]),
    listCollaborationWorkspaces: mock(async () => workspaces),
    listRemoteCollaborationWorkspaces: mock(async () => []),
    listRemoteCollaborationCandidates: mock(async () => []),
    createCollaboration: mock(async () => ({ id: 'group-one' })),
    createRemoteCollaboration: mock(async () => ({ id: 'remote-group' })),
    openRemoteCollaborationWorkspace: mock(async () => ({ ok: true })),
    openSessionInNewWindow: mock(async () => {}),
    saveSourceCredentialsBatch: mock(async () => ({ saved: 1, statusUpdateFailed: [] })),
    createSource: mock(async () => ({ slug: 'new-source' })),
    saveSourceCredentials: mock(async () => {}),
    deleteSource: mock(async () => {}),
  }
  ;(window as any).electronAPI = api
  window.confirm = () => true
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  document.body.innerHTML = ''
  await flush()
})
afterAll(async () => {
  try {
    expect(consoleErrors.mock.calls.filter(args => String(args[0]).includes('Function components cannot be given refs'))).toEqual([])
    await dom.happyDOM.close()
  } finally { consoleErrors.mockRestore() }
})

describe('CollaborationDialog real React lifecycle', () => {
  test('warns without false success after durable local creation when primary activation fails', async () => {
    api.createCollaboration = mock(async () => ({ id: 'durable-group', activationStatus: 'failed' }))
    await renderCollaboration()
    await click(element('input[type="checkbox"]'))
    await click(button('settings.collaborations.start'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledTimes(1)
    const warning = toast.warning.mock.calls[0] as any[]
    expect(warning[0]).toBe('settings.collaborations.activationFailed')
    expect(warning[1].description).toBe('settings.collaborations.activationFailedHint')
    expect(warning[1].action.label).toBe('settings.collaborations.openPrimarySession')
    expect(onOpenChange.mock.calls).toEqual([[false]])
    await act(async () => { warning[1].action.onClick() })
    expect(api.openSessionInNewWindow.mock.calls).toEqual([['w1', 'primary']])
    expect(api.createCollaboration).toHaveBeenCalledTimes(1)
  })

  test('keeps the saved-server recovery action on an activation warning without recreating the group', async () => {
    api.listRemoteCollaborationWorkspaces = mock(async () => [{ id: 'remote-main', name: 'Remote main' }])
    api.listRemoteCollaborationCandidates = mock(async () => [
      { id: 'remote-primary', workspaceId: 'remote-main', name: 'Remote primary' },
      { id: 'remote-secondary', workspaceId: 'remote-main', name: 'Remote secondary' },
    ])
    api.createRemoteCollaboration = mock(async () => ({ id: 'durable-remote-group', activationStatus: 'failed' }))
    await renderCollaboration()
    await change(serverSelect(), 'r1')
    await change(document.querySelectorAll('select')[2] as HTMLSelectElement, 'remote-primary')
    await click(element('input[type="checkbox"]'))
    await click(button('settings.collaborations.start'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    const warning = toast.warning.mock.calls[0] as any[]
    expect(warning[0]).toBe('settings.collaborations.activationFailed')
    expect(warning[1].action.label).toBe('settings.collaborations.openWorkspace')
    await act(async () => { warning[1].action.onClick() })
    expect(api.openRemoteCollaborationWorkspace.mock.calls).toEqual([['r1', 'remote-main']])
    expect(api.createRemoteCollaboration).toHaveBeenCalledTimes(1)
    expect(api.openSessionInNewWindow).not.toHaveBeenCalled()
    expect(onOpenChange.mock.calls).toEqual([[false]])
  })

  test('preserves success for legacy servers that return a raw group without activation metadata', async () => {
    await renderCollaboration()
    await click(element('input[type="checkbox"]'))
    await click(button('settings.collaborations.start'))
    expect(toast.success.mock.calls).toEqual([['settings.collaborations.started:1', undefined]])
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(onOpenChange.mock.calls).toEqual([[false]])
  })

  test('queues named new sessions across workspaces with an existing selection', async () => {
    await renderCollaboration()
    await click(element('input[type="checkbox"]'))
    await change(field('settings.collaborations.newSessionName'), 'New One')
    await click(button('settings.collaborations.newSession'))
    await change(workspaceSelect(), 'w2')
    await change(field('settings.collaborations.newSessionName'), 'New Two')
    await click(button('settings.collaborations.newSession'))
    expect(body()).toContain('New One')
    expect(body()).toContain('New Two')
    await click(button('settings.collaborations.start'))
    expect(api.createCollaboration.mock.calls).toEqual([['primary', [
      { sessionId: 'secondary', workspaceId: 'w1', name: 'Existing secondary' },
      { createNew: true, workspaceId: 'w1', name: 'New One' },
      { createNew: true, workspaceId: 'w2', name: 'New Two' },
    ]]])
    expect(onOpenChange.mock.calls).toEqual([[false]])
  })

  test('ignores late local and older-server responses after server switch', async () => {
    const local = deferred()
    const first = deferred()
    api.listCollaborationCandidates = mock(() => local.promise)
    api.listRemoteCollaborationWorkspaces = mock((id: string) => id === 'r1' ? first.promise : Promise.resolve([{ id: 'r2w', name: 'Remote Two Workspace' }]))
    api.listRemoteCollaborationCandidates = mock(async (id: string, workspaceId: string) => id === 'r2' ? [
      { id: 'r2-primary', workspaceId, name: 'Remote Two Primary' }, { id: 'r2-secondary', workspaceId, name: 'Remote Two Secondary' },
    ] : [])
    await renderCollaboration()
    await change(serverSelect(), 'r1')
    await change(serverSelect(), 'r2')
    await act(async () => { first.resolve([{ id: 'stale', name: 'Stale Remote One' }]); local.resolve([primary, secondary]) })
    await flush()
    expect(serverSelect().value).toBe('r2')
    expect(workspaceSelect().value).toBe('r2w')
    expect(body()).not.toContain('Stale Remote One')
    expect(body()).not.toContain('Existing secondary')
    await change(document.querySelectorAll('select')[2] as HTMLSelectElement, 'r2-primary')
    await click(element('input[type="checkbox"]'))
    await click(button('settings.collaborations.start'))
    expect(api.createRemoteCollaboration.mock.calls[0]).toEqual(['r2', 'r2w', 'r2-primary', [{ sessionId: 'r2-secondary', workspaceId: 'r2w', name: 'Remote Two Secondary' }]])
    expect(api.createCollaboration).not.toHaveBeenCalled()
  })

  test('close/reopen drops queued state and ignores a previous opening response', async () => {
    const old = deferred()
    api.listCollaborationCandidates = mock().mockImplementationOnce(() => old.promise).mockImplementation(async () => [primary, { ...secondary, name: 'Fresh secondary' }])
    await renderCollaboration()
    await renderCollaboration(false)
    await renderCollaboration(true)
    await act(async () => { old.resolve([primary, { ...secondary, name: 'Stale secondary' }]) })
    await flush()
    expect(body()).toContain('Fresh secondary')
    expect(body()).not.toContain('Stale secondary')
    await click(button('settings.collaborations.newSession'))
    expect(button('settings.collaborations.start').disabled).toBe(false)
    await renderCollaboration(false)
    await renderCollaboration(true)
    expect(button('settings.collaborations.start').disabled).toBe(true)
  })

  test('switching saved servers waits for the matching workspace catalog before candidate requests', async () => {
    const nextCatalog = deferred()
    api.listRemoteCollaborationWorkspaces = mock((id: string) => id === 'r1'
      ? Promise.resolve([{ id: 'r1-workspace', name: 'First catalog' }])
      : nextCatalog.promise)
    api.listRemoteCollaborationCandidates = mock(async (_id: string, workspaceId: string) => [{ id: 'remote-primary', workspaceId, name: 'Remote candidate' }])
    await renderCollaboration()
    await change(serverSelect(), 'r1')
    expect(workspaceSelect().value).toBe('r1-workspace')
    await change(serverSelect(), 'r2')
    expect(api.listRemoteCollaborationCandidates.mock.calls.filter((call: any[]) => call[0] === 'r2')).toEqual([])
    await act(async () => { nextCatalog.resolve([{ id: 'r2-workspace', name: 'Second catalog' }]) })
    await flush()
    expect(api.listRemoteCollaborationCandidates.mock.calls.filter((call: any[]) => call[0] === 'r2')).toEqual([['r2', 'r2-workspace']])
    expect(workspaceSelect().value).toBe('r2-workspace')
  })

  test('repeat submit is single-flight; busy dismissal blocked; rejection allows retry', async () => {
    const pending = deferred()
    api.createCollaboration = mock().mockImplementationOnce(() => pending.promise).mockImplementation(async () => ({ id: 'retried' }))
    await renderCollaboration()
    await click(element('input[type="checkbox"]'))
    const submit = button('settings.collaborations.start')
    await act(async () => { submit.click(); submit.click() })
    expect(api.createCollaboration).toHaveBeenCalledTimes(1)
    await click(element('[data-slot="dialog-close"]'))
    expect(onOpenChange).not.toHaveBeenCalled()
    await act(async () => { pending.reject(new Error('Synthetic failed creation')) })
    await flush()
    expect(button('settings.collaborations.start').disabled).toBe(false)
    await click(button('settings.collaborations.start'))
    expect(api.createCollaboration).toHaveBeenCalledTimes(2)
    expect(onOpenChange.mock.calls).toEqual([[false]])
  })

  test('load failure exposes retry and recovered sessions', async () => {
    api.listCollaborationCandidates = mock().mockRejectedValueOnce(new Error('Synthetic offline')).mockResolvedValue([primary, secondary])
    await renderCollaboration()
    expect(element('[role="alert"]').textContent).toContain('settings.collaborations.loadFailed')
    await click(button('settings.collaborations.reload'))
    expect(body()).toContain('Existing secondary')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('McpManagementDialog real React lifecycle', () => {
  test('invalid credential JSON never calls IPC or exposes supplied dummy text', async () => {
    await renderMcp()
    await change(field('mcpManage.credentialsBatch'), '{"existing":"dummy-never-expose",}')
    await click(button('mcpManage.saveCredentialsBatch'))
    expect(api.saveSourceCredentialsBatch).not.toHaveBeenCalled()
    expect(toast.error.mock.calls).toEqual([['mcpManage.invalidCredentials']])
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain('dummy-never-expose')
  })

  test('bulk save is single-flight, preserves failed input, and clears it after retry', async () => {
    const pending = deferred()
    api.saveSourceCredentialsBatch = mock().mockImplementationOnce(() => pending.promise).mockResolvedValue({ saved: 1, statusUpdateFailed: [] })
    await renderMcp()
    const input = '{"existing":"dummy-only-token"}'
    await change(field('mcpManage.credentialsBatch'), input)
    const submit = button('mcpManage.saveCredentialsBatch')
    await act(async () => { submit.click(); submit.click() })
    expect(api.saveSourceCredentialsBatch.mock.calls).toEqual([['w1', [{ sourceSlug: 'existing', credential: 'dummy-only-token' }]]])
    await click(element('[data-slot="dialog-close"]'))
    expect(onOpenChange).not.toHaveBeenCalled()
    await act(async () => { pending.reject(new Error('Synthetic storage failure dummy-only-token')) })
    await flush()
    expect(field('mcpManage.credentialsBatch').value).toBe(input)
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain('dummy-only-token')
    await click(button('mcpManage.saveCredentialsBatch'))
    expect(api.saveSourceCredentialsBatch).toHaveBeenCalledTimes(2)
    expect(field('mcpManage.credentialsBatch').value).toBe('')
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  test('closing and workspace switch erase all secret buffers', async () => {
    await renderMcp()
    await change(field('mcpManage.auth'), 'bearer')
    await change(field('mcpManage.token'), 'dummy-single-secret')
    await change(field('mcpManage.batch'), '{"dummy":"import-secret"}')
    await change(field('mcpManage.credentialsBatch'), '{"existing":"dummy-batch-secret"}')
    await renderMcp(false)
    await renderMcp(true)
    expect(field('mcpManage.token').value).toBe('')
    expect(field('mcpManage.batch').value).toBe('')
    expect(field('mcpManage.credentialsBatch').value).toBe('')
    await change(field('mcpManage.credentialsBatch'), '{"existing":"dummy-new-secret"}')
    await renderMcp(true, 'w2')
    expect(field('mcpManage.credentialsBatch').value).toBe('')
  })

  test('late file read after closing cannot repopulate secret import text', async () => {
    const pending = deferred<string>()
    await renderMcp()
    const input = element<HTMLInputElement>('input[type="file"]')
    Object.defineProperty(input, 'files', { configurable: true, value: [{ text: () => pending.promise }] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await renderMcp(false)
    await renderMcp(true)
    await act(async () => { pending.resolve('{"existing":"dummy-late-file-secret"}') })
    await flush()
    expect(field('mcpManage.batch').value).toBe('')
  })

  test('MCP batch skips existing and repeated names without duplicate creation', async () => {
    await renderMcp()
    await change(field('mcpManage.batch'), JSON.stringify([
      { name: 'Existing', url: 'http://local.test/existing' },
      { name: 'New Service', url: 'http://local.test/new' },
      { name: ' new service ', url: 'http://local.test/repeated' },
    ]))
    await click(button('mcpManage.importBatch'))
    expect(api.createSource).toHaveBeenCalledTimes(1)
    expect(api.createSource.mock.calls[0][1].name).toBe('New Service')
    expect(field('mcpManage.batch').value).toBe('')
  })

  test('a newer import file wins when the previous file finishes reading later', async () => {
    const oldFile = deferred<string>()
    const newFile = deferred<string>()
    await renderMcp()
    const input = element<HTMLInputElement>('input[type="file"]')
    for (const pending of [oldFile, newFile]) {
      Object.defineProperty(input, 'files', { configurable: true, value: [{ text: () => pending.promise }] })
      await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    }
    await act(async () => { newFile.resolve('newer dummy import') })
    await act(async () => { oldFile.resolve('stale dummy import') })
    await flush()
    expect(field('mcpManage.batch').value).toBe('newer dummy import')
  })

  test('failed imported credential rolls back source and leaves import available for retry', async () => {
    api.saveSourceCredentials = mock().mockRejectedValueOnce(new Error('Synthetic write failure')).mockResolvedValue(undefined)
    await renderMcp()
    const input = JSON.stringify({ mcpServers: { Service: { url: 'http://local.test/mcp', credential: 'dummy-import-token' } } })
    await change(field('mcpManage.batch'), input)
    await click(button('mcpManage.importBatch'))
    expect(api.deleteSource.mock.calls).toEqual([['w1', 'new-source']])
    expect(field('mcpManage.batch').value).toBe(input)
    await click(button('mcpManage.importBatch'))
    expect(api.createSource).toHaveBeenCalledTimes(2)
    expect(field('mcpManage.batch').value).toBe('')
  })

  test('successful save with badge or refresh failure reports warnings without retrying writes', async () => {
    api.saveSourceCredentialsBatch = mock(async () => ({ saved: 1, statusUpdateFailed: ['existing'] }))
    onRefresh = mock(async () => { throw new Error('Synthetic refresh failure') })
    await renderMcp()
    await change(field('mcpManage.credentialsBatch'), '{"existing":"dummy-token"}')
    await click(button('mcpManage.saveCredentialsBatch'))
    expect(api.saveSourceCredentialsBatch).toHaveBeenCalledTimes(1)
    expect(field('mcpManage.credentialsBatch').value).toBe('')
    expect(toast.warning.mock.calls).toEqual([['mcpManage.credentialStatusWarning'], ['mcpManage.refreshFailed']])
  })
})

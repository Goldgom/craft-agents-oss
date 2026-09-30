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
 *   bun test --tsconfig-override ./apps/electron/tsconfig.json ./scripts/tokenbird-collaboration-relay-ui.smoke.ts
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
const { MultiServerCollaborationDialog } = await import('../apps/electron/src/renderer/components/app-shell/MultiServerCollaborationDialog')
const { collaborationServerKey } = await import('../apps/electron/src/renderer/components/app-shell/collaboration-relay-selection')
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
let api: any
let close: ReturnType<typeof mock>
let context: any
const local = { kind: 'local' } as const
const saved = { kind: 'saved', profileId: 'server-two' } as const
const other = { kind: 'saved', profileId: 'server-three' } as const
const primary = { id: 'primary', workspaceId: 'w1', name: 'Fixed primary' } as any
const key = 'settings.collaborations.'
const result = (state = 'active', operationId = 'operation-existing') => ({ groupId: 'group-existing', operationId, state, activationStatus: 'queued', memberCount: 3 })
function deferred<T = any>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function flush() { await act(async () => { await Promise.resolve(); await Bun.sleep(0) }) }
async function render(open = true) { await act(async () => root.render(React.createElement(MultiServerCollaborationDialog, { primary, open, onOpenChange: close }))); await flush() }
function element<T extends Element = HTMLElement>(selector: string): T { const value = document.querySelector(selector); if (!value) throw new Error(`Missing ${selector}. ${document.body.textContent}`); return value as T }
function button(text: string): HTMLButtonElement { const value = [...document.querySelectorAll('button')].find(item => item.textContent === text); if (!value) throw new Error(`Missing button ${text}. ${document.body.textContent}`); return value }
async function click(target: Element) { await act(async () => { (target as HTMLElement).click() }); await flush() }
async function change(target: HTMLInputElement | HTMLSelectElement, value: string) { await act(async () => { const prototype = target.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value); target.dispatchEvent(new Event(target.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) }); await flush() }
const field = (label: string) => element<HTMLInputElement | HTMLSelectElement>(`[aria-label="${key}${label}"]`)
const body = () => document.body.textContent ?? ''
const checkbox = () => element<HTMLInputElement>('input[type="checkbox"]')

beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); close = mock(() => {})
  for (const fn of Object.values(toast)) fn.mockClear()
  context = { contextId: 'context-valid', relayProtocolVersion: 1, requiresRunningDesktop: true,
    primary: { server: local, serverName: 'Local', workspaceId: 'w1', workspaceName: 'Local space', sessionId: 'primary', sessionName: 'Fixed primary' },
    servers: [{ server: local, name: 'Local', credentialAvailable: true }, { server: saved, name: 'Second server', credentialAvailable: true }, { server: other, name: 'Third server', credentialAvailable: true }], pendingCreations: [] }
  api = {
    getCollaborationSetupContext: mock(async () => context),
    listCollaborationRelayWorkspaces: mock(async (server: any) => [{ id: server.kind === 'local' ? 'w1' : 'remote-space', name: server.kind === 'local' ? 'Local space' : 'Remote space' }]),
    listCollaborationRelayCandidates: mock(async (server: any, workspaceId: string) => [{ server, workspaceId, sessionId: 'same-id', name: server.kind === 'local' ? 'Local peer' : 'Remote peer' }]),
    createMultiServerCollaboration: mock(async (input: any) => result('active', input.operationId)),
    getCollaborationRelayStatus: mock(async (lookup: any) => result('committing', lookup.operationId)),
    endMultiServerCollaboration: mock(async (lookup: any) => result('ended', lookup.operationId)),
  }
  ;(window as any).electronAPI = api
})
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; await flush() })
afterAll(async () => { try { expect(consoleErrors.mock.calls.filter(args => String(args[0]).includes('Function components cannot be given refs'))).toEqual([]); await dom.happyDOM.close() } finally { consoleErrors.mockRestore() } })

describe('multi-server collaboration real React lifecycle', () => {
  test('keeps fixed primary and same-id peers from different servers in one basket', async () => {
    await render(); await click(checkbox()); await change(field('server'), collaborationServerKey(saved)); await click(checkbox())
    expect(element('[data-testid="fixed-collaboration-primary"]').textContent).toContain('Fixed primary')
    expect(body()).toContain('Local peer'); expect(body()).toContain('Remote peer')
    await click(button(key + 'start'))
    const input = api.createMultiServerCollaboration.mock.calls[0][0]
    expect(Object.keys(input).sort()).toEqual(['contextId', 'operationId', 'secondaries'])
    expect(input.secondaries).toHaveLength(2)
    expect(input.secondaries.map((item: any) => item.sessionId)).toEqual(['same-id', 'same-id'])
    expect(input.secondaries.map((item: any) => item.server)).toEqual([local, saved])
    expect(close).toHaveBeenCalledWith(false)
  })

  test('queues new sessions on multiple servers without moving the primary', async () => {
    await render(); await change(field('newSessionName'), 'Local fresh'); await click(button(key + 'newSession'))
    await change(field('server'), collaborationServerKey(saved)); await change(field('newSessionName'), 'Remote fresh'); await click(button(key + 'newSession'))
    await click(button(key + 'start'))
    expect(api.createMultiServerCollaboration.mock.calls[0][0].secondaries).toEqual([
      { server: local, workspaceId: 'w1', createNew: true, name: 'Local fresh' },
      { server: saved, workspaceId: 'remote-space', createNew: true, name: 'Remote fresh' },
    ])
  })

  test('ignores stale server catalogs and retains already selected peers', async () => {
    const old = deferred()
    const original = api.listCollaborationRelayWorkspaces
    api.listCollaborationRelayWorkspaces = mock((server: any) => server.profileId === saved.profileId ? old.promise : original(server))
    await render(); await click(checkbox()); await change(field('server'), collaborationServerKey(saved)); await change(field('server'), collaborationServerKey(other))
    await act(async () => old.resolve([{ id: 'stale-space', name: 'Stale space' }])); await flush()
    expect(body()).not.toContain('Stale space'); expect(body()).toContain('Local peer')
    expect((field('workspace') as HTMLSelectElement).value).toBe('remote-space')
  })

  test('single-flight creation ignores repeated clicks and blocks dismissal while pending', async () => {
    const pending = deferred(); api.createMultiServerCollaboration = mock(() => pending.promise)
    await render(); await click(checkbox())
    const start = button(key + 'start'); await act(async () => { start.click(); start.click() })
    expect(api.createMultiServerCollaboration).toHaveBeenCalledTimes(1)
    expect(button('common.cancel').disabled).toBe(true)
    await act(async () => pending.resolve(result('active'))); await flush()
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('uncertain reply locks the basket and retries the exact same operation', async () => {
    api.createMultiServerCollaboration = mock(async () => { throw new Error('synthetic-hidden-provider-message') })
    await render(); await click(checkbox()); await click(button(key + 'start'))
    expect(body()).toContain(key + 'relayUnknownOutcome'); expect(body()).not.toContain('synthetic-hidden-provider-message')
    expect((field('server') as HTMLSelectElement).disabled).toBe(true)
    const first = api.createMultiServerCollaboration.mock.calls[0][0]
    api.createMultiServerCollaboration.mockImplementation(async (input: any) => result('committing', input.operationId))
    await click(button(key + 'relayResume'))
    expect(api.createMultiServerCollaboration.mock.calls[1][0]).toEqual(first)
    expect(close).not.toHaveBeenCalled()
  })

  test('reload recovers durable pending creation without generating a new operation', async () => {
    const selection = { server: saved, workspaceId: 'remote-space', createNew: true, name: 'Pending peer' }
    context.pendingCreations = [{ ...result('committing', 'durable-operation'), secondaries: [selection] }]
    await render(); expect(body()).toContain('Pending peer'); expect((field('server') as HTMLSelectElement).disabled).toBe(true)
    await click(button(key + 'relayResume'))
    expect(api.createMultiServerCollaboration.mock.calls[0][0].operationId).toBe('durable-operation')
    expect(api.createMultiServerCollaboration.mock.calls[0][0].secondaries).toEqual([selection])
  })

  test('catalog retry preserves the basket and does not start any sessions', async () => {
    let fail = true
    api.listCollaborationRelayWorkspaces = mock(async (server: any) => { if (server.kind === 'saved' && fail) throw new Error('offline'); return [{ id: server.kind === 'local' ? 'w1' : 'remote-space', name: 'Space' }] })
    await render(); await click(checkbox()); await change(field('server'), collaborationServerKey(saved)); expect(body()).toContain(key + 'loadFailed')
    fail = false; await click(button(key + 'reload'))
    expect(body()).toContain('Local peer'); expect(api.getCollaborationSetupContext).toHaveBeenCalledTimes(1); expect(api.createMultiServerCollaboration).not.toHaveBeenCalled()
  })

  test('cancel and reopen erase the basket and ignore late closed-dialog results', async () => {
    await render(); await click(checkbox()); await click(button('common.cancel')); expect(api.createMultiServerCollaboration).not.toHaveBeenCalled()
    await render(false); await render(true)
    expect(checkbox().checked).toBe(false); expect(button(key + 'start').disabled).toBe(true)
  })

  test('remote primary identity does not exclude another server same-id session', async () => {
    context.primary = { ...context.primary, server: saved, serverName: 'Second server', workspaceId: 'remote-space', sessionId: 'same-id' }
    await render(); expect(document.querySelector('input[type="checkbox"]')).toBeNull()
    await change(field('server'), collaborationServerKey(local)); expect(checkbox()).toBeTruthy()
    expect(element('[data-testid="fixed-collaboration-primary"]').textContent).toContain('Second server')
  })

  test('ending requires explicit confirmation and targets the durable operation', async () => {
    context.pendingCreations = [{ ...result('paused', 'end-operation'), secondaries: [{ server: saved, workspaceId: 'remote-space', sessionId: 'same-id' }] }]
    await render(); await click(button(key + 'relayEnd'))
    expect(api.endMultiServerCollaboration).not.toHaveBeenCalled()
    const ends = [...document.querySelectorAll('button')].filter(item => item.textContent === key + 'relayEnd')
    await click(ends[1]!)
    expect(api.endMultiServerCollaboration.mock.calls[0][0]).toEqual({ operationId: 'end-operation' })
    expect(button(key + 'start').disabled).toBe(true)
  })
})

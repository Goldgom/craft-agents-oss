/** Isolated real React/Radix DOM regressions; fake native APIs, no network or saved user data.
 * TOKENBIRD_TEST_DOM_MODULE=/tmp/tokenbird-ui-test-tools/node_modules/happy-dom/lib/index.js \
 *   bun test --tsconfig-override ./apps/electron/tsconfig.json ./scripts/tokenbird-reconnect-ui.smoke.ts
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

const t = (key: string) => key
mock.module('react-i18next', () => ({ useTranslation: () => ({ t }) }))
const React = await import('react')
// Keep the real Spinner while avoiding unrelated PDF viewer worker imports in
// the UI barrel, which require Vite's ?url transform.
const { Spinner } = await import('../packages/ui/src/components/ui/LoadingIndicator')
mock.module('@craft-agent/ui', () => ({ Spinner }))
const { createRoot } = await import('react-dom/client')
const { act } = React
const { AddWorkspaceStep_ConnectRemote } = await import('../apps/electron/src/renderer/components/workspace/AddWorkspaceStep_ConnectRemote')
const { validateRemoteWorkspaceInput } = await import('../packages/server-core/src/handlers/rpc/workspace-remote-input')
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
let api: any
let props: any
let unmounted = false
const secret = 'dummy-new-write-only-token'
const initialUrl = 'wss://example.invalid/remote'
const body = () => document.body.textContent ?? ''
function deferred<T = any>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function flush() { await act(async () => { await Promise.resolve(); await Bun.sleep(0) }) }
async function render(extra: any = {}) { props = { ...props, ...extra }; await act(async () => root.render(React.createElement(AddWorkspaceStep_ConnectRemote, props))); await flush() }
function button(label: string): HTMLButtonElement { const result = [...document.querySelectorAll('button')].find(e => e.textContent === label); if (!result) throw new Error(`Missing button ${label}`); return result }
const urlInput = () => document.querySelector('input[aria-label="Server URL"]') as HTMLInputElement
const tokenInput = () => document.querySelector('input[type="password"]') as HTMLInputElement
async function click(target: Element) { await act(async () => { (target as HTMLElement).click() }); await flush() }
async function change(target: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value); target.dispatchEvent(new Event('input', { bubbles: true })) }); await flush()
}
async function unmount() { if (!unmounted) { await act(async () => root.unmount()); unmounted = true } }
const success = { ok: true, remoteWorkspaces: [{ id: 'remote-1', name: 'Remote' }], serverVersion: '0.0.0-test' }
const savedAction = 'workspace.reconnectSavedToken'
const newAction = 'workspace.reconnectAction'
beforeEach(() => {
  unmounted = false
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  api = { getHomeDir: mock(async () => '/tmp/dummy-ui-home'), testRemoteConnection: mock(async () => success), checkWorkspaceSlug: mock(async () => ({ exists: false, path: '/tmp/dummy-ui-workspace' })), invokeOnServer: mock(async () => ({ id: 'remote-new', name: 'Remote new' })) }
  ;(window as any).electronAPI = api
  props = { initialUrl, initialToken: '', reconnectWorkspace: { id: 'local-1', name: 'Saved', remoteWorkspaceId: 'remote-1' }, isCreating: false, onBack: mock(() => {}), onUpdate: mock(async () => {}), onCreate: mock(async () => {}) }
})
afterEach(async () => { await unmount(); document.body.innerHTML = ''; await flush() })
afterAll(async () => { await dom.happyDOM.close() })

describe('write-only remote workspace reconnect', () => {
  test('blank unchanged endpoint reconnects through the real preserve helper without a fake test result', async () => {
    const existing = { url: initialUrl, token: 'dummy-stored-token', remoteWorkspaceId: 'remote-1' }
    let saved: any
    props.onUpdate = mock(async (_id: string, input: unknown) => { saved = validateRemoteWorkspaceInput(input, existing) })
    await render()
    expect(tokenInput().value).toBe('')
    expect(button(savedAction).disabled).toBe(false)
    expect(button('Test Connection').disabled).toBe(true)
    expect(body()).toContain('workspace.savedTokenReconnectHint')
    expect(body()).not.toContain('Connected')
    await click(button(savedAction))
    expect(props.onUpdate).toHaveBeenCalledWith('local-1', { url: initialUrl, token: '', remoteWorkspaceId: 'remote-1' })
    expect(saved).toEqual(existing)
    expect(api.testRemoteConnection).not.toHaveBeenCalled()
    expect(body()).not.toContain(existing.token)
    expect(body()).not.toContain('Connected')
  })

  test('URL identity matches backend canonical href, but changed path/query/scheme/host cannot retain token', async () => {
    await render({ initialUrl: 'wss://EXAMPLE.invalid:443' })
    await change(urlInput(), 'wss://example.invalid/')
    expect(button(savedAction).disabled).toBe(false)
    for (const url of ['wss://example.invalid/other', 'wss://example.invalid/?a=1', 'ws://example.invalid', 'wss://other.invalid', 'not a URL', 'wss://user:pass@example.invalid/', 'wss://example.invalid/#fragment']) {
      await change(urlInput(), url)
      expect(button(newAction).disabled).toBe(true)
      expect(button('Test Connection').disabled).toBe(true)
      expect(body()).toContain('workspace.changedEndpointTokenRequired')
    }
    expect(props.onUpdate).not.toHaveBeenCalled()
  })

  test('changed endpoint requires explicit token and successful test, then clears token after save', async () => {
    await render(); await change(urlInput(), 'wss://changed.invalid'); await change(tokenInput(), secret)
    expect(button(newAction).disabled).toBe(true)
    await click(button('Test Connection'))
    expect(api.testRemoteConnection).toHaveBeenCalledWith('wss://changed.invalid', secret)
    expect(button(newAction).disabled).toBe(false)
    await click(button(newAction))
    expect(props.onUpdate).toHaveBeenCalledWith('local-1', { url: 'wss://changed.invalid', token: secret, remoteWorkspaceId: 'remote-1' })
    expect(tokenInput().value).toBe('')
  })

  test('new workspaces still require a token and real successful test', async () => {
    await render({ reconnectWorkspace: undefined, onUpdate: undefined })
    expect(button('Connect').disabled).toBe(true)
    expect(button('Test Connection').disabled).toBe(true)
    await change(tokenInput(), secret); await click(button('Test Connection'))
    expect(button('Connect').disabled).toBe(false)
    await click(button('Connect'))
    expect(props.onCreate).toHaveBeenCalledWith('/tmp/dummy-ui-workspace', 'Remote', { url: initialUrl, token: secret, remoteWorkspaceId: 'remote-1' })
  })

  test('rapid reconnect clicks submit once and keep controls disabled until it settles', async () => {
    const pending = deferred(); props.onUpdate = mock(() => pending.promise)
    await render(); const connect = button(savedAction)
    await act(async () => { connect.click(); connect.click() }); await flush()
    expect(props.onUpdate).toHaveBeenCalledTimes(1)
    expect(urlInput().disabled).toBe(true)
    expect(tokenInput().disabled).toBe(true)
    expect(button('Back').disabled).toBe(true)
    await act(async () => pending.resolve(undefined)); await flush()
    expect(button(savedAction).disabled).toBe(false)
  })

  test('save failure is sanitized, keeps entered token for correction, and can be retried', async () => {
    props.onUpdate = mock(async () => { throw new Error(secret) })
    await render(); await change(tokenInput(), secret); await click(button('Test Connection')); await click(button(newAction))
    expect(body()).toContain('workspace.remoteReconnectFailed')
    expect(body()).not.toContain(secret)
    expect(tokenInput().value).toBe(secret)
    await change(tokenInput(), '')
    expect(button(savedAction).disabled).toBe(false)
  })

  test('late test success cannot authorize an edited endpoint or restore stale workspace results', async () => {
    const pending = deferred(); api.testRemoteConnection = mock(() => pending.promise)
    await render(); await change(tokenInput(), secret); await click(button('Test Connection'))
    await change(urlInput(), 'wss://changed.invalid')
    await act(async () => pending.resolve(success)); await flush()
    expect(body()).not.toContain('Connected')
    expect(button(newAction).disabled).toBe(true)
    expect(props.onUpdate).not.toHaveBeenCalled()
  })

  test('late test failure cannot overwrite a newer successful test; results are never logged', async () => {
    const old = deferred(); api.testRemoteConnection = mock().mockImplementationOnce(() => old.promise).mockResolvedValue({ ...success, error: secret })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await render(); await change(tokenInput(), secret); await click(button('Test Connection'))
      await change(tokenInput(), 'dummy-second-token'); await click(button('Test Connection'))
      await act(async () => old.reject(new Error(secret))); await flush()
      expect(button(newAction).disabled).toBe(false)
      expect(body()).toContain('Connected')
      expect(body()).not.toContain(secret)
      expect(log).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  })

  test('returned test error cannot echo submitted credentials', async () => {
    api.testRemoteConnection = mock(async () => ({ ok: false, error: secret }))
    await render(); await change(tokenInput(), secret); await click(button('Test Connection'))
    expect(body()).toContain('workspace.remoteConnectionFailed')
    expect(body()).not.toContain(secret)
    expect(button(newAction).disabled).toBe(true)
  })

  test('back clears token and invalidates a pending test even before unmount', async () => {
    const pending = deferred(); api.testRemoteConnection = mock(() => pending.promise)
    await render(); await change(tokenInput(), secret); await click(button('Test Connection')); await click(button('Back'))
    expect(props.onBack).toHaveBeenCalledTimes(1)
    expect(tokenInput().value).toBe('')
    await act(async () => pending.resolve(success)); await flush()
    expect(body()).not.toContain('Connected')
  })

  test('workspace change clears write-only buffer and discards previous test', async () => {
    const pending = deferred(); api.testRemoteConnection = mock(() => pending.promise)
    await render(); await change(tokenInput(), secret); await click(button('Test Connection'))
    await render({ reconnectWorkspace: { id: 'local-2', name: 'Second', remoteWorkspaceId: 'remote-2' }, initialUrl: 'wss://second.invalid' })
    expect(tokenInput().value).toBe('')
    await act(async () => pending.resolve(success)); await flush()
    expect(body()).not.toContain('Connected')
    await click(button(savedAction))
    expect(props.onUpdate).toHaveBeenCalledWith('local-2', { url: 'wss://second.invalid', token: '', remoteWorkspaceId: 'remote-2' })
  })

  test('unmount during test or reconnect makes late errors inert', async () => {
    const pending = deferred(); api.testRemoteConnection = mock(() => pending.promise)
    await render(); await change(tokenInput(), secret); await click(button('Test Connection')); await unmount()
    await act(async () => pending.reject(new Error(secret))); await flush()
    expect(props.onUpdate).not.toHaveBeenCalled()
    expect(document.body.textContent).toBe('')
  })

  test('unmount after remote creation prevents a later local workspace mutation', async () => {
    const pending = deferred(); api.testRemoteConnection = mock(async () => ({ ok: true, needsWorkspace: true })); api.invokeOnServer = mock(() => pending.promise)
    await render({ reconnectWorkspace: undefined, onUpdate: undefined }); await change(tokenInput(), secret); await click(button('Test Connection'))
    const name = document.querySelector('input[placeholder="workspace.myRemoteWorkspace"]') as HTMLInputElement
    await change(name, 'Dummy fresh'); await click(button('Create and Connect')); await unmount()
    await act(async () => pending.resolve({ id: 'created', name: 'Dummy fresh' })); await flush()
    expect(api.invokeOnServer).toHaveBeenCalledTimes(1)
    expect(api.checkWorkspaceSlug).not.toHaveBeenCalled()
    expect(props.onCreate).not.toHaveBeenCalled()
  })
})

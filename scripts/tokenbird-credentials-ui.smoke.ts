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
 *   bun test --tsconfig-override ./apps/electron/tsconfig.json ./scripts/tokenbird-credentials-ui.smoke.ts
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
mock.module('../apps/electron/src/renderer/components/app-shell/PanelHeader', () => ({ PanelHeader: ({ title, actions }: any) => React.createElement('header', null, title, actions) }))
mock.module('../apps/electron/src/renderer/components/ui/scroll-area', () => ({ ScrollArea: ({ children }: any) => React.createElement('div', null, children) }))
const { createRoot } = await import('react-dom/client')
const { act } = React
const { NativeCredentialManager } = await import('../apps/electron/src/renderer/components/settings/NativeCredentialManager')
mock.module('@craft-agent/ui', () => ({ Spinner: () => React.createElement('span') }))
const { AuthRequestCard } = await import('../apps/electron/src/renderer/components/chat/AuthRequestCard')
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
let api: any
let workspace = 'w1'
const secret = 'dummy-ui-write-only-secret'
const prefix = 'settings.credentials.'
const inventory = [{ id: { type: 'llm_api_key', connectionSlug: 'provider' }, hasValue: true, presentFields: ['value', 'refreshToken'] }]
let status: any
const response = () => ({ status: { ...status }, scope: { workspaceId: workspace, sourceWorkspaceId: workspace, sourceScopeUnavailable: false, includesGlobal: true, includesLlm: true }, entries: inventory.map(e => ({ ...e })) })
const ok = (value: any) => ({ ok: true, value })
function deferred<T = any>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function flush() { await act(async () => { await Promise.resolve(); await Bun.sleep(0) }) }
async function render(id: string | null = workspace) { await act(async () => root.render(React.createElement(NativeCredentialManager, { workspaceId: id }))); await flush() }
function element<T extends Element = HTMLElement>(selector: string): T { const result = document.querySelector(selector); if (!result) throw new Error(`Missing ${selector}. ${document.body.textContent}`); return result as T }
function button(text: string): HTMLButtonElement { const result = [...document.querySelectorAll('button')].find(e => e.textContent === text); if (!result) throw new Error(`Missing button ${text}. ${document.body.textContent}`); return result }
async function click(target: Element) { await act(async () => { (target as HTMLElement).click() }); await flush() }
async function change(target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  await act(async () => { const prototype = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : target.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value); target.dispatchEvent(new Event(target.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) }); await flush()
}
const field = (key: string) => element<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${prefix}${key}"]`)
const body = () => document.body.textContent ?? ''
const dialog = () => element('[role="dialog"]')

test('AI credential form keeps exact passwords, shows a safe retry error, and clears the secret after success', async () => {
  const response = mock(async () => { throw new Error(secret) })
  const message = { id: 'auth', role: 'auth-request', timestamp: 1, content: '', authRequestId: 'request', authRequestType: 'credential', authStatus: 'pending', authSourceName: 'Work', authSourceSlug: 'Work', authCredentialMode: 'basic', authSavedCredentialName: 'Work', authSavedCredentialKind: 'password', authHint: 'credentialSave' } as any
  await act(async () => root.render(React.createElement(AuthRequestCard, { message, sessionId: 'session', onRespondToCredential: response })))
  await flush()
  await change(element<HTMLInputElement>('#auth-username-request'), 'me@example.com')
  await change(element<HTMLInputElement>('#auth-password-request'), `  ${secret}  `)
  await click(button('Save'))
  expect(body()).toContain(`${prefix}saveFailedRetry`)
  expect(body()).not.toContain(secret)
  expect(button('Save').disabled).toBe(false)
  expect(response.mock.calls).toHaveLength(1)
  response.mockImplementation(async () => {})
  await click(button('Save'))
  expect((element<HTMLInputElement>('#auth-password-request')).value).toBe('')
  expect((response.mock.calls as any)[1][2].password).toBe(`  ${secret}  `)
})

beforeEach(async () => {
  workspace = 'w1'
  status = { state: 'ready', protection: 'legacy-machine', backend: null, canList: true, canApply: true, canMigrate: false, legacyBackupAvailable: false, requiresSeparateHeadlessConfig: false }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  for (const value of Object.values(toast)) value.mockClear()
  api = {
    getNativeCredentialStatus: mock(async () => ok(response())),
    listNativeCredentials: mock(async () => ok(response())),
    applyNativeCredentialChanges: mock(async () => ok({ ...response(), upsertedCount: 1, deletedCount: 0 })),
    migrateNativeCredentials: mock(async () => ok({ ...response(), migratedCredentialCount: 1, backupCreated: true })),
  }
  ;(window as any).electronAPI = api
})
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; await flush() })
afterAll(async () => { try { expect(consoleErrors.mock.calls.filter(args => String(args[0]).includes('Function components cannot be given refs'))).toEqual([]); await dom.happyDOM.close() } finally { consoleErrors.mockRestore() } })

describe('native credential Settings lifecycle', () => {
  test('healthy legacy remains editable without OS support, upgrade, or reauthentication', async () => {
    await render()
    expect(body()).toContain(`${prefix}legacyUsable`)
    expect(body()).toContain(`${prefix}upgradeUnavailable`)
    expect(button(`${prefix}add`).disabled).toBe(false)
    expect(api.migrateNativeCredentials).not.toHaveBeenCalled()
    expect(api.applyNativeCredentialChanges).not.toHaveBeenCalled()
  })

  test('remote/browser contexts stay native-only without RPC or reauth fallback', async () => {
    api.getNativeCredentialStatus = mock(async () => ({ ok: false, code: 'SCOPE_NOT_ALLOWED', message: secret }))
    await render()
    expect(body()).toContain(`${prefix}errors.SCOPE_NOT_ALLOWED`)
    expect(body()).not.toContain(secret)
    expect(api.listNativeCredentials).not.toHaveBeenCalled()
    expect(button(`${prefix}add`).disabled).toBe(true)
    ;(window as any).electronAPI = {}
    workspace = 'w2'; await render()
    expect(body()).toContain(`${prefix}errors.NATIVE_ONLY`)
  })

  test('inventory is metadata-only and update fields always start blank', async () => {
    api.listNativeCredentials = mock(async () => ok({ ...response(), entries: [{ ...inventory[0], value: secret, refreshToken: secret }] }))
    await render()
    expect(body()).not.toContain(secret)
    await click(button(`${prefix}update`))
    expect((field('secretValue') as HTMLInputElement).value).toBe('')
    expect((field('secretValue') as HTMLInputElement).type).toBe('password')
    await change(field('secretValue'), secret)
    await click(button('common.cancel'))
    await click(button(`${prefix}update`))
    expect((field('secretValue') as HTMLInputElement).value).toBe('')
  })

  test('write-only review and rapid apply clicks send one atomic request, then clear buffers', async () => {
    const pending = deferred()
    api.applyNativeCredentialChanges = mock(() => pending.promise)
    await render(); await click(button(`${prefix}update`)); await change(field('secretValue'), secret); await click(button(`${prefix}review`))
    expect(body()).not.toContain(secret)
    expect(document.querySelector('input[type="password"]')).toBeNull()
    const apply = button(`${prefix}apply`)
    await act(async () => { apply.click(); apply.click() })
    expect(api.applyNativeCredentialChanges).toHaveBeenCalledTimes(1)
    expect(api.applyNativeCredentialChanges.mock.calls[0][0]).toEqual({ changes: [{ op: 'upsert', id: inventory[0].id, credential: { value: secret } }] })
    await act(async () => pending.resolve(ok({ ...response(), upsertedCount: 1, deletedCount: 0 }))); await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click(button(`${prefix}update`)); expect((field('secretValue') as HTMLInputElement).value).toBe('')
  })

  test('selected deletion requires exact review and explicit acknowledgement', async () => {
    await render(); await click(element('input[type="checkbox"]')); await click(button(`${prefix}deleteSelected:1`))
    expect(body()).toContain('llm_api_key::provider')
    expect(button(`${prefix}apply`).disabled).toBe(true)
    await click(button('common.cancel')); expect(api.applyNativeCredentialChanges).not.toHaveBeenCalled()
    await click(button(`${prefix}deleteSelected:1`)); await click(dialog().querySelector('input[type="checkbox"]')!); await click(button(`${prefix}apply`))
    expect(api.applyNativeCredentialChanges.mock.calls[0][0]).toEqual({ changes: [{ op: 'delete', id: inventory[0].id }] })
  })

  test('optional migration requires compatibility acknowledgement and preserves legacy after failure', async () => {
    status.canMigrate = true; status.backend = 'keychain'
    api.migrateNativeCredentials = mock(async () => ({ ok: false, code: 'PROTECTION_UPGRADE_FAILED', message: secret }))
    await render(); await click(button(`${prefix}upgrade`))
    expect(body()).toContain(`${prefix}upgradeWarning`)
    expect(button(`${prefix}confirmUpgrade`).disabled).toBe(true)
    expect(api.migrateNativeCredentials).not.toHaveBeenCalled()
    await click(dialog().querySelector('input[type="checkbox"]')!); await click(button(`${prefix}confirmUpgrade`))
    expect(api.migrateNativeCredentials.mock.calls[0][0]).toEqual({ acknowledgeHeadlessIncompatibility: true })
    expect(toast.error.mock.calls[0][0]).toBe(`${prefix}errors.PROTECTION_UPGRADE_FAILED`)
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain(secret)
    await click(button('common.cancel')); expect(button(`${prefix}add`).disabled).toBe(false)
  })

  test('bulk import validates locally and secret values are absent from preview', async () => {
    await render(); await click(button(`${prefix}import`)); await change(field('importJson'), `{"bad":"${secret}"}`); await click(button(`${prefix}review`))
    expect(body()).toContain(`${prefix}invalidImport`); expect(api.applyNativeCredentialChanges).not.toHaveBeenCalled()
    await change(field('importJson'), JSON.stringify({ changes: [{ op: 'upsert', id: inventory[0].id, credential: { value: secret, refreshToken: null } }] })); await click(button(`${prefix}review`))
    expect(body()).not.toContain(secret); expect(document.querySelector('textarea')).toBeNull()
    await click(button('common.cancel')); await click(button(`${prefix}import`)); expect((field('importJson') as HTMLTextAreaElement).value).toBe('')
  })

  test('workspace switch clears secret dialogs and ignores stale inventory responses', async () => {
    await render(); await click(button(`${prefix}import`)); await change(field('importJson'), secret)
    const stale = deferred(); api.listNativeCredentials = mock(() => stale.promise)
    await click(button('common.cancel')); await click(button('common.refresh'))
    api.listNativeCredentials = mock(async () => ok({ ...response(), entries: [{ id: { type: 'source_bearer', workspaceId: workspace, sourceId: 'new-source' }, hasValue: true, presentFields: ['value'] }] }))
    workspace = 'w2'; await render()
    await act(async () => stale.resolve(ok({ ...response(), scope: { workspaceId: 'w1', sourceWorkspaceId: 'w1', sourceScopeUnavailable: false, includesGlobal: true, includesLlm: true }, entries: inventory }))); await flush()
    expect(body()).toContain('source_bearer::w2::new-source'); expect(body()).not.toContain('llm_api_key::provider')
    await click(button(`${prefix}import`)); expect((field('importJson') as HTMLTextAreaElement).value).toBe('')
    await change(field('importJson'), secret); workspace = 'w3'; await render(); expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  test('late imported-file reads cannot restore a canceled secret buffer', async () => {
    const late = deferred<string>()
    await render(); await click(button(`${prefix}import`))
    const fileInput = field('chooseFile') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [{ size: 42, text: () => late.promise }] })
    await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true }))); await flush()
    await click(button('common.cancel')); await click(button(`${prefix}import`))
    await act(async () => late.resolve(secret)); await flush()
    expect((field('importJson') as HTMLTextAreaElement).value).toBe('')
  })

  test('Escape dismisses a secret editor and reopening cannot reveal its previous buffer', async () => {
    await render(); await click(button(`${prefix}update`)); await change(field('secretValue'), secret)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click(button(`${prefix}update`)); expect((field('secretValue') as HTMLInputElement).value).toBe('')
  })

  test('successful optional upgrade refreshes native status without changing credential values', async () => {
    status.canMigrate = true; status.backend = 'keychain'
    api.migrateNativeCredentials = mock(async () => {
      status = { ...status, protection: 'electron-safe-storage', canMigrate: false, requiresSeparateHeadlessConfig: true, legacyBackupAvailable: true }
      return ok({ ...response(), migratedCredentialCount: 1, backupCreated: true })
    })
    await render(); await click(button(`${prefix}upgrade`)); await click(dialog().querySelector('input[type="checkbox"]')!); await click(button(`${prefix}confirmUpgrade`))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(body()).toContain(`${prefix}protection.electron-safe-storage`)
    expect(body()).toContain(`${prefix}backupAvailable`)
    expect(body()).toContain(`${prefix}headlessSeparate`)
    expect(api.applyNativeCredentialChanges).not.toHaveBeenCalled()
  })

  test('failed writes show fixed diagnostics, never raw secret errors or false success', async () => {
    api.applyNativeCredentialChanges = mock(async () => { throw new Error(secret) })
    await render(); await click(button(`${prefix}update`)); await change(field('secretValue'), secret); await click(button(`${prefix}review`)); await click(button(`${prefix}apply`))
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error.mock.calls[0][0]).toBe(`${prefix}errors.UNKNOWN`)
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain(secret)
    expect(button(`${prefix}apply`).disabled).toBe(false)
    await click(button('common.cancel')); await click(button(`${prefix}update`)); expect((field('secretValue') as HTMLInputElement).value).toBe('')
  })

  test('old mutation completion cannot close or overwrite a newer workspace editor', async () => {
    const pending = deferred(); api.applyNativeCredentialChanges = mock(() => pending.promise)
    await render(); await click(button(`${prefix}update`)); await change(field('secretValue'), secret); await click(button(`${prefix}review`)); await click(button(`${prefix}apply`))
    workspace = 'w2'; await render(); await click(button(`${prefix}update`)); await change(field('secretValue'), 'new-workspace-secret')
    await act(async () => pending.resolve(ok({ ...response(), upsertedCount: 1, deletedCount: 0 }))); await flush()
    expect((field('secretValue') as HTMLInputElement).value).toBe('new-workspace-secret')
    expect(toast.success).not.toHaveBeenCalled()
  })

  test('optional edits preserve omitted primary secret and require explicit clear semantics', async () => {
    await render(); await click(button(`${prefix}update`))
    await change(element<HTMLSelectElement>('[aria-label="settings.credentials.fieldAction"]'), 'clear')
    await click(button(`${prefix}review`)); await click(button(`${prefix}apply`))
    expect(api.applyNativeCredentialChanges.mock.calls[0][0]).toEqual({ changes: [{ op: 'upsert', id: inventory[0].id, credential: { refreshToken: null } }] })
    await click(button(`${prefix}update`))
    const actions = document.querySelectorAll<HTMLSelectElement>('[aria-label="settings.credentials.fieldAction"]')
    await change(actions[1], 'set'); await click(button(`${prefix}review`))
    expect(body()).toContain(`${prefix}invalidImport`)
    expect(api.applyNativeCredentialChanges).toHaveBeenCalledTimes(1)
  })

  test('newer manual import text wins over an older pending file read', async () => {
    const late = deferred<string>()
    await render(); await click(button(`${prefix}import`))
    const fileInput = field('chooseFile') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [{ size: 42, text: () => late.promise }] })
    await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true }))); await flush()
    await change(field('importJson'), 'newer text')
    await act(async () => late.resolve(secret)); await flush()
    expect((field('importJson') as HTMLTextAreaElement).value).toBe('newer text')
  })

  test('canceling an optional upgrade does not mutate the usable legacy vault', async () => {
    status.canMigrate = true; status.backend = 'keychain'
    await render(); await click(button(`${prefix}upgrade`)); await click(dialog().querySelector('input[type="checkbox"]')!); await click(button('common.cancel'))
    expect(api.migrateNativeCredentials).not.toHaveBeenCalled()
    expect(api.applyNativeCredentialChanges).not.toHaveBeenCalled()
    expect(button(`${prefix}add`).disabled).toBe(false)
    await click(button(`${prefix}upgrade`)); expect(button(`${prefix}confirmUpgrade`).disabled).toBe(true)
  })

  test('adding a credential requires a new secret and sends only the chosen domain fields', async () => {
    await render(); await click(button(`${prefix}add`))
    await change(field('credentialType'), 'llm_api_key')
    await change(field('identifier.connectionSlug'), 'new-provider'); await click(button(`${prefix}review`))
    expect(body()).toContain(`${prefix}invalidImport`); expect(api.applyNativeCredentialChanges).not.toHaveBeenCalled()
    await change(field('secretValue'), secret); await click(button(`${prefix}review`)); await click(button(`${prefix}apply`))
    expect(api.applyNativeCredentialChanges.mock.calls[0][0]).toEqual({ changes: [{ op: 'upsert', id: { type: 'llm_api_key', connectionSlug: 'new-provider' }, credential: { value: secret } }] })
  })

  test('named account is the default editor and the reviewed password stays hidden', async () => {
    await render(); await click(button(`${prefix}add`))
    expect((field('credentialType') as HTMLSelectElement).value).toBe('saved_credential')
    await change(field('identifier.name'), '工作邮箱')
    await change(field('username'), 'me@example.com')
    await change(field('website'), 'https://example.com/login')
    await change(field('secretValue'), `  ${secret}  `)
    await click(button(`${prefix}review`))
    expect(body()).not.toContain(secret)
    await click(button(`${prefix}apply`))
    expect(api.applyNativeCredentialChanges.mock.calls[0][0]).toEqual({ changes: [{ op: 'upsert', id: { type: 'saved_credential', workspaceId: workspace, name: '工作邮箱' }, credential: { value: `  ${secret}  `, credentialKind: 'password', username: 'me@example.com', credentialUrl: 'https://example.com/login' } }] })
  })

  test('named metadata is searchable and editable while the existing password remains unread', async () => {
    api.listNativeCredentials = mock(async () => ok({ ...response(), entries: [{ id: { type: 'saved_credential', workspaceId: workspace, name: 'Work' }, username: 'me@example.com', credentialKind: 'password', credentialUrl: 'https://example.com', hasValue: true, presentFields: ['value', 'username'] }] }))
    await render()
    await change(field('search'), 'me@example.com')
    expect(body()).toContain('Work')
    await click(button(`${prefix}update`))
    expect((field('username') as HTMLInputElement).value).toBe('me@example.com')
    expect((field('secretValue') as HTMLInputElement).value).toBe('')
    await change(field('username'), 'new@example.com')
    await click(button(`${prefix}review`)); await click(button(`${prefix}apply`))
    expect(api.applyNativeCredentialChanges.mock.calls[0][0].changes[0].credential).toEqual({ credentialKind: 'password', username: 'new@example.com', credentialUrl: 'https://example.com' })
  })

  test('an unavailable already-native vault stays fail-closed without a legacy or reauth fallback', async () => {
    status = { ...status, state: 'unavailable', protection: 'electron-safe-storage', canList: false, canApply: false, requiresSeparateHeadlessConfig: true, errorCode: 'OS_STORAGE_UNAVAILABLE' }
    await render()
    expect(body()).toContain(`${prefix}errors.OS_STORAGE_UNAVAILABLE`)
    expect(body()).not.toContain(`${prefix}legacyUsable`)
    expect(button(`${prefix}add`).disabled).toBe(true)
    expect(api.listNativeCredentials).not.toHaveBeenCalled()
    expect(api.migrateNativeCredentials).not.toHaveBeenCalled()
  })
})

test('source editor uses the main-resolved directory namespace, never the registered UUID', async () => {
  workspace = 'registered-uuid'
  const sourceEntry = { id: { type: 'source_bearer', workspaceId: 'directory-slug', sourceId: 'source' }, hasValue: true, presentFields: ['value'] }
  const scoped = () => ({ ...response(), scope: { ...response().scope, sourceWorkspaceId: 'directory-slug' }, entries: [sourceEntry] })
  api.getNativeCredentialStatus = mock(async () => ok(scoped())); api.listNativeCredentials = mock(async () => ok(scoped()))
  await render(); await click(button(`${prefix}update`)); expect((field('identifier.workspaceId') as HTMLInputElement).value).toBe('directory-slug')
  await change(field('secretValue'), secret); await click(button(`${prefix}review`)); await click(button(`${prefix}apply`))
  expect(api.applyNativeCredentialChanges.mock.calls[0][0].changes[0].id.workspaceId).toBe('directory-slug')
})
test('ambiguous source scope is visibly disabled without blocking global or LLM edits', async () => {
  const scoped = () => ({ ...response(), scope: { ...response().scope, sourceWorkspaceId: null, sourceScopeUnavailable: true } })
  api.getNativeCredentialStatus = mock(async () => ok(scoped())); api.listNativeCredentials = mock(async () => ok(scoped()))
  await render(); expect(body()).toContain(`${prefix}sourceScopeUnavailable`); expect(button(`${prefix}add`).disabled).toBe(false)
  await click(button(`${prefix}add`)); const sourceOption = element<HTMLOptionElement>('option[value="source_bearer"]'); expect(sourceOption.disabled).toBe(true)
})
test('managed remote metadata is navigation-only and cannot enter a generic atomic batch', async () => {
  api.listNativeCredentials = mock(async () => ok({ ...response(), managedEntries: [{ kind: 'remote-profile', id: 'profile-one', profileId: 'profile-one', name: 'Managed Remote', serverOrigin: 'https://remote.invalid', fields: ['token'], protection: 'encrypted-vault', settingsTarget: 'remoteServers', ignoredSecret: secret }] }))
  await render(); expect(body()).toContain('Managed Remote'); expect(body()).not.toContain(secret)
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
  let navigated: any
  const listener = (event: Event) => { navigated = (event as CustomEvent).detail }
  window.addEventListener('craft-agent-navigate', listener)
  try { await click(button(`${prefix}manageConnections`)); expect(navigated.route).toBe('settings/remoteServers') } finally { window.removeEventListener('craft-agent-navigate', listener) }
  expect(api.applyNativeCredentialChanges).not.toHaveBeenCalled()
})
test('post-commit runtime warning keeps save successful, clears secrets, and does not invite a retry', async () => {
  api.applyNativeCredentialChanges = mock(async () => ok({ ...response(), upsertedCount: 1, deletedCount: 0, warnings: ['RUNTIME_RECONCILIATION_PENDING'] }))
  await render(); await click(button(`${prefix}update`)); await change(field('secretValue'), secret); await click(button(`${prefix}review`)); await click(button(`${prefix}apply`))
  expect(api.applyNativeCredentialChanges).toHaveBeenCalledTimes(1); expect(toast.error).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled()
  expect(toast.warning.mock.calls[0][0]).toBe(`${prefix}savedRuntimePending`); expect(document.querySelector('[role="dialog"]')).toBeNull()
})

test('metadata search includes managed profiles without a contradictory empty result', async () => {
  api.listNativeCredentials = mock(async () => ok({ ...response(), managedEntries: [{ kind: 'remote-profile', id: 'managed-profile', profileId: 'managed-profile', name: 'Find This Profile', serverOrigin: 'https://managed.invalid', fields: ['token'], protection: 'encrypted-vault', settingsTarget: 'remoteServers' }] }))
  await render(); await change(field('search'), 'Find This Profile')
  expect(body()).toContain('Find This Profile'); expect(body()).not.toContain(`${prefix}noMatches`); expect(body()).not.toContain('llm_api_key::provider')
})

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18next from 'i18next'
import { initReactI18next, I18nextProvider } from 'react-i18next'
import en from '../../../../../../packages/shared/src/i18n/locales/en.json'
import StudioCanvas from './StudioCanvas'
import { AppShellProvider, type AppShellContextType } from '@/context/AppShellContext'
import { ModalProvider } from '@/context/ModalContext'
import { putStudioSession } from './studio-sessions'
import { saveStudioGeneration } from './studio-generation-history'

declare global {
  interface Window { runMobileChecks: (width: number, height: number, android?: boolean) => Promise<string[]> }
}

/** Mounted production UI, production CSS, real Canvas/IndexedDB. Native API boundary is a fixture. */
window.runMobileChecks = async (width, height, android = false) => {
  const checks: string[] = []
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(`${width}x${height}: ${message}`) }
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: 'en', keySeparator: false, resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  environment.IS_REACT_ACT_ENVIRONMENT = true
  sessionStorage.setItem('tokenbird.studio.imageSetupDismissed', '1')
  localStorage.removeItem('tokenbird.studio.fingerNavigation')
  document.documentElement.dataset.mobileApp = android ? 'android' : ''
  let command: ((input: Record<string, unknown>) => Promise<unknown>) | undefined
  window.electronAPI = {
    listLlmConnectionsWithStatus: async () => [],
    onLlmConnectionsChanged: () => () => {},
    onStudioCanvasRequest: (callback: typeof command) => { command = callback; return () => { command = undefined } },
  } as unknown as typeof window.electronAPI
  await putStudioSession({ id: 'mobile-fixture', mode: 'canvas', title: 'Mobile fixture', updatedAt: Date.now() }, '')
  const thumbnail = document.createElement('canvas'); thumbnail.width = 2; thumbnail.height = 2
  const image = await new Promise<Blob>(resolve => thumbnail.toBlob(blob => resolve(blob!)))
  await saveStudioGeneration({ id: 'mobile-preview', createdAt: Date.now(), sessionId: 'mobile-fixture', sessionTitle: 'Mobile fixture', kind: 'generate', prompt: 'Preview fixture', model: 'fixture', connectionName: 'fixture', width: 2, height: 2, image })
  const node = document.createElement('div')
  node.style.cssText = `height:${height}px;width:${width}px;`
  document.body.appendChild(node)
  const root: Root = createRoot(node)
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) }) }
  const button = (label: string, scope: ParentNode = document) => {
    const found = Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(b => b.getAttribute('aria-label') === label || b.title === label || b.textContent === label)
    assert(found && !found.disabled, `Missing control: ${label}`)
    return found!
  }
  const click = async (label: string, scope: ParentNode = document) => { await act(async () => button(label, scope).click()) }
  const capture = async (phase: string) => {
    const callback = (window as unknown as { mobileCapture?: (phase: string) => Promise<void> }).mobileCapture
    if (!callback) return
    await settle()
    await act(async () => callback(phase))
  }
  const state = async () => command!({ action: 'get_state' }) as Promise<{ view: { x: number; y: number; zoom: number }; layers: Array<{ id: string; tiles: number }> }>
  const invoke = async (input: Record<string, unknown>) => { let result: unknown; await act(async () => { result = await command!(input) }); return result }
  const pointer = async (kind: string, id: number, type: string, x: number, y: number) => {
    const canvas = node.querySelector('canvas')!, rect = canvas.getBoundingClientRect()
    // Synthetic pointer events exercise React ownership/cancellation; capture is native-only.
    await act(async () => canvas.dispatchEvent(new PointerEvent(kind, { bubbles: true, pointerId: id, pointerType: type, button: 0, buttons: kind === 'pointerup' ? 0 : 1, clientX: rect.left + x, clientY: rect.top + y })))
  }
  try {
    await act(async () => root.render(<I18nextProvider i18n={i18n}><ModalProvider><AppShellProvider value={{ workspaceDefaultLlmConnection: undefined } as AppShellContextType}><StudioCanvas onOpenAiSettings={() => {}} /></AppShellProvider></ModalProvider></I18nextProvider>))
    await settle(); await settle()
    assert(command, 'Canvas AI interface was not registered')
    const compact = width < 1000 || (width <= 1100 && height < 500) || android
    assert(node.querySelector('[data-studio-editor]')?.getAttribute('data-compact') === String(compact), 'Wrong responsive layout')
    if (!compact) {
      assert(!node.querySelector('[data-studio-mobile-controls]') && node.querySelector('[data-studio-inspector]'), 'Desktop inspector or toolbar regressed')
      await invoke({ action: 'add_layer', name: 'Rotation fixture' })
      const count = (await state()).layers.length
      await act(async () => { node.style.width = '390px' }); await settle(); await settle()
      assert(node.querySelector('[data-studio-mobile-controls]'), `Narrow workspace did not switch to compact layout: ${node.querySelector('[data-studio-session-compact]')?.getBoundingClientRect().width}, ${node.firstElementChild?.getBoundingClientRect().width}`)
      await click(en['studio.mobile.allTools'])
      await act(async () => { node.style.width = `${width}px` }); await settle(); await settle()
      assert(node.querySelector('[data-studio-inspector]') && !document.querySelector('[data-studio-mobile-sheet]'), 'Expanded workspace kept mobile modal open')
      assert((await state()).layers.length === count, 'Responsive transition lost editor state')
      await act(async () => { node.style.width = '390px' }); await settle(); await settle()
      assert(!document.querySelector('[data-studio-mobile-sheet]'), 'Returning to compact reopened a stale sheet')
      return ['desktop keeps persistent tool rail and inspector; container resizing preserves layers and dismisses mobile sheets']
    }
    const canvas = node.querySelector('canvas')!
    const canvasRect = canvas.getBoundingClientRect()
    assert(canvasRect.width >= width - 2 && canvasRect.height >= height - 250, `Canvas space lost: ${JSON.stringify(canvasRect.toJSON())}`)
    assert(!node.querySelector('[data-studio-inspector]') && !node.querySelector('[data-studio-session-sidebar]'), 'Permanent sidebar covers mobile canvas')
    for (const b of Array.from(node.querySelectorAll<HTMLElement>('.studio-mobile-dock button, [data-studio-mobile-header] button'))) assert(b.getBoundingClientRect().width >= 44 && b.getBoundingClientRect().height >= 44, 'Touch target is too small')
    assert(node.scrollWidth <= width + 1, 'Workspace overflows phone width')
    checks.push('full width canvas, no permanent sidebars, 44px touch targets')
    await click(en['studio.retouch.brush'])
    assert(!document.querySelector('[data-studio-mobile-sheet]'), 'Brush selection opened an obstructing modal')
    await capture('canvas')
    const previewButton = button(en['studio.showPreview']), previewRect = previewButton.getBoundingClientRect()
    assert(previewButton.contains(document.elementFromPoint(previewRect.left + previewRect.width / 2, previewRect.top + previewRect.height / 2)), 'Recent preview button is covered by zoom controls')
    await click(en['studio.showPreview'])
    assert(node.querySelector('img[alt="Preview fixture"]'), 'Mobile preview toggle failed to reveal recent image')
    await click(en['studio.hidePreview'])
    assert(!node.querySelector('img[alt="Preview fixture"]'), 'Mobile preview cannot be dismissed')
    checks.push('recent images start collapsed and open/close on demand')
    await click(en['studio.mobile.allTools'])
    let sheet = document.querySelector<HTMLElement>('[data-studio-mobile-sheet]')!
    assert(sheet, 'Full tool picker did not open')
    let sheetRect = sheet.getBoundingClientRect()
    assert(sheetRect.left >= -1 && sheetRect.right <= width + 1 && sheetRect.top >= -1 && sheetRect.bottom <= height + 1, `Tool sheet outside viewport: ${JSON.stringify(sheetRect.toJSON())}`)
    assert(!document.activeElement?.matches('input, textarea'), 'Tool picker opened the keyboard')
    await capture('tools')
    await click(en['studio.retouch.text'], sheet)
    assert(document.querySelector('[data-studio-inspector] textarea'), 'Text properties did not open')
    const viewportDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport')!
    const keyboardViewport = Object.assign(new EventTarget(), { height: 260, width, offsetTop: 16, offsetLeft: 0, pageTop: 16, pageLeft: 0, scale: 1 })
    try {
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: keyboardViewport })
      await act(async () => window.dispatchEvent(new Event('resize')))
      const keyboardPanel = document.querySelector<HTMLElement>('[data-studio-mobile-sheet]')!
      const keyboardSheet = keyboardPanel.getBoundingClientRect()
      assert(keyboardSheet.top >= 15 && keyboardSheet.bottom <= 277, `Sheet obscured by keyboard: ${JSON.stringify(keyboardSheet.toJSON())}`)
    } finally {
      Object.defineProperty(window, 'visualViewport', viewportDescriptor)
      await act(async () => window.dispatchEvent(new Event('resize')))
    }
    await click(en['common.close'])
    await click(en['studio.retouch.brush'])
    checks.push('all tools picker, contextual properties, keyboard viewport avoidance, close restores canvas')
    await click(en['studio.layersProperties'])
    await click(en['studio.newLayer'])
    assert((await state()).layers.length >= 2, 'Layer action unavailable for brush on mobile')
    const fingerOption = document.querySelector<HTMLInputElement>('.studio-sheet-body input[type="checkbox"]')!
    await act(async () => fingerOption.click())
    await click(en['common.close'])
    const viewBefore = (await state()).view
    // Synthetic events have no active pointer capture in Chromium.
    canvas.setPointerCapture = () => {}
    canvas.hasPointerCapture = () => false
    await pointer('pointerdown', 1, 'touch', 80, 80)
    await pointer('pointermove', 1, 'touch', 100, 90)
    await pointer('pointerup', 1, 'touch', 100, 90)
    const navState = await state()
    assert(navState.view.x === viewBefore.x + 20 && navState.view.y === viewBefore.y + 10, 'Finger-only navigation did not pan')
    assert(navState.layers.every(layer => !layer.tiles), 'Finger-only navigation left a brush stroke')
    checks.push('layer controls available without changing tools; finger-only pan does not paint')
    await click(en['studio.layersProperties'])
    await act(async () => document.querySelector<HTMLInputElement>('.studio-sheet-body input[type="checkbox"]')!.click())
    await click(en['common.close'])
    await pointer('pointerdown', 10, 'touch', 70, 70)
    await pointer('pointermove', 10, 'touch', 80, 80)
    await pointer('pointerdown', 11, 'touch', 150, 70)
    await pointer('pointermove', 11, 'touch', 200, 70)
    await pointer('pointerup', 11, 'touch', 200, 70)
    await pointer('pointermove', 10, 'touch', 100, 100)
    await pointer('pointerup', 10, 'touch', 100, 100)
    assert((await state()).layers.every(layer => !layer.tiles), 'Pinch left a tentative/residual brush stroke')
    checks.push('pinch cancels tentative paint; surviving finger never paints')
    await pointer('pointerdown', 20, 'touch', 70, 70)
    await pointer('pointermove', 20, 'touch', 80, 80)
    await pointer('pointerdown', 21, 'pen', 160, 100)
    await pointer('pointermove', 21, 'pen', 180, 100)
    await pointer('pointerdown', 22, 'touch', 40, 40)
    await pointer('pointermove', 22, 'touch', 50, 50)
    await pointer('pointerup', 21, 'pen', 180, 100)
    await pointer('pointerup', 20, 'touch', 80, 80)
    await pointer('pointerup', 22, 'touch', 50, 50)
    assert((await state()).layers.some(layer => layer.tiles), 'Pen failed to take over from finger')
    await invoke({ action: 'undo' })
    assert((await state()).layers.every(layer => !layer.tiles), 'Palm rejection or pen takeover left extra undo/stroke')
    checks.push('pen takes priority, palm is ignored, one undo removes only the pen stroke')
    await click(en['studio.mobile.files'])
    assert(button(en['studio.importImage']) && button(en['studio.openProject']) && button(en['studio.saveProject']), 'File actions missing')
    await click(en['studio.ps.export'])
    assert(document.querySelector('[data-studio-inspector]'), 'Export settings not reachable')
    await click(en['common.close'])
    await click(en['studio.canvasSessions'])
    assert(document.querySelector('[data-studio-session-sidebar] button[title="' + en['studio.rename'] + '"]')?.getBoundingClientRect().width! >= 44, 'Session rename is hover-only')
    await click('Mobile fixture', document.querySelector('[data-studio-session-sidebar]')!)
    assert(!document.querySelector('[data-studio-mobile-sheet]'), 'Selecting a session left drawer open')
    checks.push('files/export reachable; sessions have touch rename/delete and close after selection')
    return checks
  } finally {
    await act(async () => root.unmount())
    node.remove()
    document.documentElement.removeAttribute('data-mobile-app')
    environment.IS_REACT_ACT_ENVIRONMENT = false
  }
}

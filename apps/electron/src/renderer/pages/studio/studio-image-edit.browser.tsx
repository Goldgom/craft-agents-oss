import { act } from 'react'
import { createRoot } from 'react-dom/client'
import i18next from 'i18next'
import { initReactI18next, I18nextProvider } from 'react-i18next'
import en from '../../../../../../packages/shared/src/i18n/locales/en.json'
import StudioCanvas from './StudioCanvas'
import { AppShellProvider, type AppShellContextType } from '@/context/AppShellContext'
import { ModalProvider } from '@/context/ModalContext'
import { putStudioSession, setActiveStudioSessionId } from './studio-sessions'
import { createLayer, drawImageOnLayer, rawLayer, rasterizeRegion } from './canvas-engine'
import { deserializeLayers, serializeLayer } from './canvas-photoshop'

declare global { interface Window { runImageEditChecks: () => Promise<string[]> } }

/** Exercise the production request -> candidate -> tiled canvas -> undo path in Chromium. */
window.runImageEditChecks = async () => {
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message) }
  const checks: string[] = []
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: 'en', keySeparator: false, resources: { en: { translation: en } } })
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  sessionStorage.setItem('tokenbird.studio.imageSetupDismissed', '1')
  const art = document.createElement('canvas'); art.width = 1200; art.height = 300
  const ctx = art.getContext('2d')!, pixels = ctx.createImageData(1200, 300)
  for (let i = 0; i < pixels.data.length; i += 4) pixels.data.set([i / 4 % 2 ? 20 : 240, 90, 170, 255], i)
  ctx.putImageData(pixels, 0, 0)
  const original = createLayer('Original'); original.offset = { x: 7, y: -9 }
  const bounds = { x: -200, y: -100, width: 1200, height: 300 }
  drawImageOnLayer(original, art, bounds)
  const data = JSON.stringify({ version: 1, activeId: original.id, layers: [serializeLayer(original)] })
  await putStudioSession({ id: 'image-edit-fixture', mode: 'canvas', title: 'Image edit', updatedAt: Date.now() }, data)
  setActiveStudioSessionId('canvas', 'image-edit-fixture')
  let command: ((input: Record<string, unknown>) => Promise<unknown>) | undefined
  const patchAlpha = 128
  window.electronAPI = {
    listLlmConnectionsWithStatus: async () => [{ slug: 'image-fixture', name: 'Image fixture', authType: 'api_key', piAuthProvider: 'openai', isAuthenticated: true, models: ['gpt-image-1'] }],
    onLlmConnectionsChanged: () => () => {},
    onStudioCanvasRequest: (callback: typeof command) => { command = callback; return () => {} },
    generateStudioImage: async (input: { imageBase64: string; maskBase64: string }) => {
      const decode = async (base64: string) => { const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode(); return image }
      const output = document.createElement('canvas'); output.width = output.height = 1254
      const context = output.getContext('2d')!
      if (!input.imageBase64) {
        context.fillStyle = '#000'; context.fillRect(0, 0, output.width, output.height)
        context.fillStyle = '#00ff00'; context.fillRect(587, 587, 80, 80)
        return { imageBase64: output.toDataURL().split(',')[1], mimeType: 'image/png' }
      }
      context.drawImage(await decode(input.imageBase64), 0, 0, 1254, 1254)
      const mask = document.createElement('canvas'); mask.width = mask.height = 1254
      mask.getContext('2d')!.drawImage(await decode(input.maskBase64), 0, 0, 1254, 1254)
      const returned = context.getImageData(0, 0, 1254, 1254), alpha = mask.getContext('2d')!.getImageData(0, 0, 1254, 1254)
      for (let i = 0; i < returned.data.length; i += 4) if (alpha.data[i + 3] === 0) returned.data.set([255, 40, 10, patchAlpha], i)
      context.putImageData(returned, 0, 0)
      if (alpha.data[(627 * 1254 + 627) * 4 + 3] === 0) {
        assert(alpha.data[(40 * 1254 + 627) * 4 + 3] === 255, 'Wide edit left the padding editable')
        context.fillStyle = '#00ff00'; context.fillRect(587, 587, 80, 80)
      }
      return { imageBase64: output.toDataURL('image/png').split(',')[1], mimeType: 'image/png' }
    },
  } as unknown as typeof window.electronAPI
  const node = document.createElement('div'); node.style.cssText = 'width:1200px;height:800px'; document.body.appendChild(node)
  const root = createRoot(node)
  const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) })
  const invoke = async (input: Record<string, unknown>) => { let result: unknown; await act(async () => { result = await command!(input) }); return result }
  const exportPixels = async (rect = bounds) => {
    const saved = await invoke({ action: 'save_project', outputPath: 'fixture.tbcanvas' }) as { base64: string }
    const project = JSON.parse(atob(saved.base64))
    const layers = await deserializeLayers(project.layers)
    return rasterizeRegion(layers.map(rawLayer), rect, rect.width, rect.height).getContext('2d')!.getImageData(0, 0, rect.width, rect.height)
  }
  const assertSquare = (image: ImageData) => {
    let horizontal = 0, vertical = 0
    const centerX = Math.floor(image.width / 2), centerY = Math.floor(image.height / 2)
    for (let x = 0; x < image.width; x++) if (image.data[(centerY * image.width + x) * 4 + 1] > 245) horizontal++
    for (let y = 0; y < image.height; y++) if (image.data[(y * image.width + centerX) * 4 + 1] > 245) vertical++
    assert(horizontal > 10 && Math.abs(horizontal - vertical) <= 1, `Generated square changed aspect ratio: ${horizontal}x${vertical} in ${image.width}x${image.height}`)
  }
  try {
    await act(async () => root.render(<I18nextProvider i18n={i18n}><ModalProvider><AppShellProvider value={{ llmConnections: [] } as unknown as AppShellContextType}><StudioCanvas onOpenAiSettings={() => {}} /></AppShellProvider></ModalProvider></I18nextProvider>))
    await settle(); await settle()
    await invoke({ action: 'set_parameters', connectionSlug: 'image-fixture', model: 'gpt-image-1', count: 1 })
    await settle()
    await invoke({ action: 'set_selection', ...bounds })
    const gif = await invoke({ action: 'generate_gif', frameCount: 2, maxSize: 64 }) as { base64: string; mime: string; frames: number }
    assert(gif.mime === 'image/gif' && gif.frames === 2 && atob(gif.base64).startsWith('GIF89a'), 'Canvas AI bridge did not generate a GIF')
    checks.push('Production canvas command bridge exports the current selection as GIF')
    const result = await invoke({ action: 'generate', mode: 'inpaint', prompt: 'Edit fixture' }) as { status: string }
    assert(result.status === 'applied', 'Inpaint candidate did not apply')
    const edited = await exportPixels()
    assertSquare(edited)
    for (let i = 3; i < edited.data.length; i += 4) assert(edited.data[i] === 255, 'Translucent response punched a hole in opaque artwork')
    for (let x = 0; x < bounds.width; x++) {
      const i = x * 4
      assert(edited.data.slice(i, i + 4).join() === pixels.data.slice(i, i + 4).join(), 'Protected native pixels were resampled')
    }
    checks.push('1254px translucent provider result preserves opaque artwork and exact native boundary pixels across offset tiles')
    await invoke({ action: 'undo' })
    assert((await exportPixels()).data.every((v, i) => v === pixels.data[i]), 'Undo did not restore the exact source')
    await invoke({ action: 'redo' })
    assert((await exportPixels()).data.every((v, i) => v === edited.data[i]), 'Redo changed the edit result')
    checks.push('edit undo and redo restore every pixel')
    await invoke({ action: 'undo' })
    const expansion = { ...bounds, width: 1600 }
    await invoke({ action: 'set_selection', ...expansion })
    const expanded = await invoke({ action: 'generate', mode: 'outpaint', prompt: 'Expansion fixture' }) as { status: string }
    assert(expanded.status === 'applied', 'Outpaint candidate did not apply')
    const output = await exportPixels(expansion)
    assert(output.data[(150 * 1600 + 1300) * 4 + 3] === patchAlpha, 'Outpaint discarded generated blank pixels')
    for (let y = 0; y < 300; y++) for (let x = 0; x < 1150; x++) for (let c = 0; c < 4; c++) {
      assert(output.data[(y * 1600 + x) * 4 + c] === pixels.data[(y * 1200 + x) * 4 + c], 'Outpaint resampled protected artwork')
    }
    checks.push('outpaint preserves original colors and detail while filling the blank area')
    const portrait = { ...bounds, width: 180, height: 600 }
    await invoke({ action: 'set_selection', ...portrait })
    const generated = await invoke({ action: 'generate', mode: 'generate', prompt: 'Square marker' }) as { status: string }
    assert(generated.status === 'applied', 'Portrait generation did not apply')
    assertSquare(await exportPixels(portrait))
    checks.push('Square provider detail stays square in wide edits and portrait generations')
    const large = { x: -600, y: -100, width: 8010, height: 4000 }
    await invoke({ action: 'set_selection', ...large })
    const before = await exportPixels()
    let calls = 0, failAt = 3
    window.electronAPI.generateStudioImage = async input => {
      calls++
      if (calls === failAt) throw new Error('tile failure fixture')
      const tile = document.createElement('canvas'); tile.width = tile.height = 128
      const ctx = tile.getContext('2d')!
      ctx.fillStyle = calls % 2 ? '#ff0000' : '#0000ff'; ctx.fillRect(0, 0, 128, 128)
      if (calls > 1) assert(input.size === '1024x1024' && input.count === 1 && input.imageBase64, 'Tile did not use its guide')
      return { imageBase64: tile.toDataURL().split(',')[1], mimeType: 'image/png', images: [] }
    }
    try { await invoke({ action: 'generate', mode: 'generate', prompt: 'Tile fixture' }) }
    catch (error) { assert(String(error).includes('tile failure fixture'), 'Unexpected generation error') }
    assert(calls === 3 && (await exportPixels()).data.every((v, i) => v === before.data[i]), 'Failed tile changed the canvas')
    calls = 0; failAt = 0
    const largeResult = await invoke({ action: 'generate', mode: 'generate', prompt: 'Tile fixture' }) as { status: string }
    assert(calls === 7 && largeResult.status === 'applied', 'Oversized canvas did not use a guide and six tiles')
    const seam = await exportPixels({ x: large.x + 2670 - 200, y: large.y + 500, width: 400, height: 1 })
    assert(seam.data[2] === 255 && seam.data[399 * 4] === 255, 'Adjacent tiles landed at incorrect positions')
    assert(seam.data[200 * 4] > 80 && seam.data[200 * 4 + 2] > 80 && seam.data[200 * 4 + 3] === 255, 'Overlap is not an opaque cross-fade')
    await invoke({ action: 'undo' })
    assert((await exportPixels()).data.every((v, i) => v === before.data[i]), 'One undo did not restore the tiled generation')
    checks.push('32-million-pixel limit splits into overlapping tiles, blends the seam and undoes as one layer')
    checks.push('a failed middle tile leaves the original canvas intact and the full request can be retried')
    await invoke({ action: 'undo' }) // portrait generation
    await invoke({ action: 'undo' }) // single-request outpaint
    const originalPixels = await exportPixels()
    const wide = { x: -513, y: -513, width: 15900, height: 1026 }
    await invoke({ action: 'set_selection', ...wide })
    calls = 0
    window.electronAPI.generateStudioImage = async input => {
      calls++
      assert(input.imageBase64 && input.maskBase64, 'Outpaint tile is missing its reference or mask')
      const tile = document.createElement('canvas'); tile.width = tile.height = 1024
      const ctx = tile.getContext('2d')!
      for (const [data, mask] of [[input.imageBase64, false], [input.maskBase64, true]] as const) {
        const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode()
        if (!mask) ctx.drawImage(image, 0, 0)
        else {
          const maskCanvas = document.createElement('canvas'); maskCanvas.width = maskCanvas.height = 1024
          const mctx = maskCanvas.getContext('2d')!; mctx.fillStyle = '#ff8800'; mctx.fillRect(0, 0, 1024, 1024)
          mctx.globalCompositeOperation = 'destination-out'; mctx.drawImage(image, 0, 0)
          ctx.drawImage(maskCanvas, 0, 0)
        }
      }
      return { imageBase64: tile.toDataURL().split(',')[1], mimeType: 'image/png', images: [] }
    }
    const outpaint = await invoke({ action: 'generate', mode: 'outpaint', prompt: 'Large extension' }) as { status: string }
    assert(outpaint.status === 'applied' && calls > 2, 'Tile-count limit did not split the edit')
    const preserved = await exportPixels()
    for (let y = 40; y < 260; y++) for (let x = 40; x < 1160; x++) {
      const i = (y * 1200 + x) * 4
      assert(preserved.data[i] === originalPixels.data[i], 'Tiled outpaint changed original native detail')
    }
    const edge = await exportPixels({ x: wide.x + wide.width - 1, y: 10, width: 2, height: 1 })
    assert(edge.data[3] === 255 && edge.data[7] === 0, 'Tiled outpaint did not stop at the selected edge')
    await invoke({ action: 'undo' })
    assert((await exportPixels()).data.every((v, i) => v === originalPixels.data[i]), 'Tiled outpaint undo lost source detail')
    checks.push('132-tile outpaint fills the far edge, keeps native detail and restores the original in one undo')
    const cutoutBounds = { x: -400, y: 700, width: 4200, height: 300 }
    await invoke({ action: 'set_selection', ...cutoutBounds })
    await invoke({ action: 'set_parameters', count: 2 })
    calls = 0
    window.electronAPI.generateStudioImage = async input => {
      assert(input.transparentBackground && input.imageBase64 && input.count === 1, 'Missing cutout tile settings')
      const tile = document.createElement('canvas'); tile.width = tile.height = 64
      const ctx = tile.getContext('2d')!
      ctx.fillStyle = ++calls <= 2 ? '#ff000080' : '#00ff0080'; ctx.fillRect(0, 0, 64, 64)
      return { imageBase64: tile.toDataURL().split(',')[1], mimeType: 'image/png', images: [] }
    }
    const variants = await invoke({ action: 'generate', mode: 'cutout' }) as { status: string; count: number }
    assert(variants.status === 'candidates' && variants.count === 2 && calls === 4, 'Cutout tiles were returned as individual candidates')
    await invoke({ action: 'choose_candidate', candidateIndex: 1 })
    const cutoutSeam = await exportPixels({ x: 1700, y: 850, width: 1, height: 1 })
    assert(cutoutSeam.data.join() === '0,255,0,128', 'Cutout overlap changed alpha or mixed candidates')
    checks.push('oversized cutout preserves transparent seams and keeps two complete candidates independently selectable')
    return checks
  } finally { await act(async () => root.unmount()); node.remove() }
}

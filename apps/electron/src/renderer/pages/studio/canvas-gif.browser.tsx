import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import en from '@tokenbird/shared/i18n/locales/en.json'
import { generateSelectionGif } from './canvas-gif'
import { CanvasGifPanel } from './CanvasGifPanel'
import { createLayer, drawImageOnLayer } from './canvas-engine'
import { rectangularSelection } from './canvas-retouch'

declare global { interface Window { runGifChecks: () => Promise<string[]> } }
window.runGifChecks = async () => {
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message) }
  const checks: string[] = [], bounds = { x: -10, y: 8, width: 32, height: 24 }
  const layers = ['#ff0000', '#0000ff'].map(color => {
    const layer = createLayer(color), image = document.createElement('canvas')
    image.width = 32; image.height = 24
    const ctx = image.getContext('2d')!; ctx.fillStyle = color; ctx.fillRect(0, 0, 32, 24)
    ctx.clearRect(4, 4, 4, 4)
    drawImageOnLayer(layer, image, bounds); return layer
  })
  const selection = rectangularSelection(bounds)
  selection.mask.width = 32; selection.mask.height = 24
  selection.mask.getContext('2d')!.fillRect(0, 0, 32, 24)
  selection.mask.getContext('2d')!.clearRect(10, 10, 4, 4)
  const before = layers.map(layer => [...layer.tiles.values()].map(tile => tile.toDataURL()).join()).join()
  const result = await generateSelectionGif(layers, selection, { gifMode: 'layers', layerIds: [layers[1].id, layers[0].id], frameDelay: 120, repeat: -1 })
  const data = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0))
  assert(new TextDecoder().decode(data.slice(0, 6)) === 'GIF89a', 'Not a GIF')
  // Chromium decodes the real LZW frames; no mocked encoder or parser.
  const Decoder = (window as unknown as { ImageDecoder: new (input: unknown) => {
    tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } }
    decode(input: { frameIndex: number }): Promise<{ image: CanvasImageSource & { duration: number; close(): void } }>
    close(): void
  } }).ImageDecoder
  const decoder = new Decoder({ data, type: 'image/gif' })
  await decoder.tracks.ready
  assert(decoder.tracks.selectedTrack.frameCount === 2, 'Wrong frame count')
  assert(result.width === 32 && result.height === 24 && result.durationMs === 240, 'Wrong output metadata')
  for (let i = 0; i < 2; i++) {
    const { image } = await decoder.decode({ frameIndex: i })
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0)
    const rgba = ctx.getImageData(0, 0, 32, 24).data
    assert(rgba[i === 0 ? 2 : 0] > 240 && rgba[i === 0 ? 0 : 2] < 15, 'Explicit layer frame order lost')
    assert(rgba[(11 * 32 + 11) * 4 + 3] === 0, 'Selection hole lost')
    assert(rgba[(5 * 32 + 5) * 4 + 3] === 0, 'Source transparency lost')
    assert(image.duration === 120000, 'Frame delay lost')
    image.close()
  }
  decoder.close()
  checks.push('Real GIF decodes with correct layer order, duration, negative world origin and transparent holes')
  const zoom = await generateSelectionGif(layers, selection, { frameCount: 4, maxSize: 16 })
  const zoomDecoder = new Decoder({ data: Uint8Array.from(atob(zoom.base64), c => c.charCodeAt(0)), type: 'image/gif' })
  await zoomDecoder.tracks.ready
  assert(zoomDecoder.tracks.selectedTrack.frameCount === 4 && zoom.width === 16 && zoom.height === 12, 'Zoom sizing failed')
  const framePixels: string[] = []
  for (let i = 0; i < 3; i++) {
    const { image } = await zoomDecoder.decode({ frameIndex: i })
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 12
    canvas.getContext('2d')!.drawImage(image, 0, 0); framePixels.push(canvas.toDataURL()); image.close()
  }
  assert(new Set(framePixels).size > 1, 'Zoom frames are identical')
  zoomDecoder.close()
  assert(before === layers.map(layer => [...layer.tiles.values()].map(tile => tile.toDataURL()).join()).join(), 'Export mutated layer pixels')
  checks.push('Looping zoom produces distinct frames, preserves aspect ratio and leaves source layers unchanged')
  for (const [source, mask, input] of [[layers, null, {}], [layers.slice(0, 1), selection, { gifMode: 'layers' }],
    [layers, selection, { layerIds: ['missing'] }], [layers, selection, { frameDelay: 0 }],
    [[createLayer('empty')], selection, {}]] as const) {
    let failed = false
    try { await generateSelectionGif([...source], mask, input) } catch { failed = true }
    assert(failed, 'Invalid or empty GIF input accepted')
  }
  checks.push('Missing selection, missing layers, invalid timing and empty content are rejected')

  const i18n = i18next.createInstance()
  await i18n.init({ lng: 'en', keySeparator: false, resources: { en: { translation: en } } })
  const node = document.createElement('div'); document.body.appendChild(node)
  const root = createRoot(node), saves: string[] = []
  let completed: Promise<unknown> | undefined
  const render = (hasSelection: boolean) => <I18nextProvider i18n={i18n}><CanvasGifPanel hasSelection={hasSelection} onCommand={input => {
    completed = generateSelectionGif(layers, selection, input); return completed
  }} onSave={(url, name) => saves.push(`${name}:${url.slice(0, 22)}`)} /></I18nextProvider>
  await act(async () => root.render(render(false)))
  const button = () => Array.from(node.querySelectorAll('button')).find(button => button.textContent === en['studio.gif.generate'])!
  assert(button().disabled, 'Generate enabled without selection')
  await act(async () => root.render(render(true)))
  await act(async () => { button().click(); await completed })
  assert(saves.length === 1 && saves[0].startsWith('tokenbird-selection.gif:data:image/gif;base64,'), 'One-click GIF download failed')
  assert(node.querySelector('img')?.src.startsWith('data:image/gif;base64,'), 'Preview missing')
  await act(async () => root.unmount()); node.remove()
  checks.push('One-click UI disables without selection, generates, downloads and previews the GIF')
  return checks
}

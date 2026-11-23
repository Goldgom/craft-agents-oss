import { GIFEncoder, quantize, applyPalette } from 'gifenc'
import { rasterizeRegion, type CanvasLayer } from './canvas-engine'
import { checkedSelectionBounds, selectionMask, type PixelSelection } from './canvas-retouch'
import { canvasImage } from './canvas-photoshop'

export function gifOptions(input: Record<string, unknown>) {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = input[key] ?? fallback
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${key}: ${min}–${max}`)
    return value
  }
  const gifMode = input.gifMode ?? 'zoom'
  if (gifMode !== 'zoom' && gifMode !== 'layers') throw new Error('gifMode: zoom | layers')
  return { gifMode, frameCount: integer('frameCount', 20, 2, 60), frameDelay: integer('frameDelay', 100, 20, 2000),
    repeat: integer('repeat', 0, -1, 100), maxSize: integer('maxSize', 512, 16, 1024) }
}

/** Export a snapshot without mutating layers, selections or editor history. */
export async function generateSelectionGif(layers: CanvasLayer[], selection: PixelSelection | null, input: Record<string, unknown>) {
  if (!selection) throw new Error('请先创建图片选区')
  const options = gifOptions(input), bounds = checkedSelectionBounds(selection.bounds)
  let frames = layers.filter(layer => layer.visible && !layer.groupHidden)
  if (input.layerIds !== undefined) {
    const ids = input.layerIds
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !frames.some(layer => layer.id === id))) throw new Error('请选择有效且可见、不重复的图层')
    frames = ids.map(id => frames.find(layer => layer.id === id)!)
  }
  const count = options.gifMode === 'layers' ? frames.length : options.frameCount
  if (count < 2 || count > 60) throw new Error('逐帧 GIF 需要 2–60 个可见图层')
  const scale = Math.min(1, options.maxSize / Math.max(bounds.width, bounds.height))
  const width = Math.max(1, Math.round(bounds.width * scale)), height = Math.max(1, Math.round(bounds.height * scale))
  if (width * height * count > 24_000_000) throw new Error('GIF 过大，请减少帧数或输出尺寸')
  const mask = selectionMask(selection, bounds, width, height)
  const snapshot = (source: CanvasLayer[]) => {
    const canvas = rasterizeRegion(source, bounds, width, height), ctx = canvas.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(mask, 0, 0)
    return canvas
  }
  const source = options.gifMode === 'zoom' ? snapshot(frames) : null
  const layerFrames = source ? [] : frames.map(layer => snapshot([{ ...layer, blendMode: 'source-over', clipping: false }]))
  const gif = GIFEncoder(), frame = canvasImage(width, height), ctx = frame.getContext('2d')!
  let hasPixels = false
  for (let i = 0; i < count; i++) {
    // Yield between bounded frames so controls and progress can paint.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, width, height)
    if (source) {
      const zoom = 1 + .12 * (1 - Math.cos(2 * Math.PI * i / count)) / 2
      ctx.drawImage(source, (width - width * zoom) / 2, (height - height * zoom) / 2, width * zoom, height * zoom)
      ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(mask, 0, 0)
    } else {
      // Individual layers are frames, so blending/clipping against other frames is disabled.
      ctx.drawImage(layerFrames[i], 0, 0)
    }
    const rgba = ctx.getImageData(0, 0, width, height).data
    const colors = quantize(rgba, 255), indexes = applyPalette(rgba, colors)
    // Reserve index 0 explicitly: GIF has binary alpha, including selection holes.
    for (let p = 0; p < indexes.length; p++) {
      const opaque = rgba[p * 4 + 3] >= 128
      indexes[p] = opaque ? indexes[p] + 1 : 0
      hasPixels ||= opaque
    }
    gif.writeFrame(indexes, width, height, { palette: [[0, 0, 0], ...colors], delay: options.frameDelay,
      repeat: options.repeat, transparent: true, transparentIndex: 0, dispose: 2 })
  }
  if (!hasPixels) throw new Error('选区内没有可导出的可见像素')
  gif.finish()
  const bytes = gif.bytes()
  if (bytes.length > 8_000_000) throw new Error('GIF 超过 8 MB，请减少帧数或尺寸')
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  const frameDelay = Math.round(options.frameDelay / 10) * 10
  return { base64: btoa(binary), mime: 'image/gif', width, height, frames: count, frameDelay,
    durationMs: count * frameDelay, repeat: options.repeat, bytes: bytes.length }
}

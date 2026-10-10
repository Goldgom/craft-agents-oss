import { TILE_SIZE, rawLayer, captureTile, rasterizeRegion, tileKey, type CanvasLayer, type Rect, type TileSnapshot } from './canvas-engine'
import { blendSelectionPixels, selectionMask, type PixelSelection } from './canvas-retouch'

export type AdjustmentStyle = 'none' | 'grayscale' | 'sepia' | 'vintage' | 'noir'
export type AdjustmentSettings = {
  brightness: number
  contrast: number
  saturation: number
  hue: number
  temperature: number
  blur: number
  style: AdjustmentStyle
}

export const defaultAdjustments: AdjustmentSettings = {
  brightness: 100, contrast: 100, saturation: 100, hue: 0, temperature: 0, blur: 0, style: 'none',
}

export function adjustmentsAreNeutral(settings: AdjustmentSettings): boolean {
  return colorAdjustmentsAreNeutral(settings) && settings.blur === 0
}

function colorAdjustmentsAreNeutral(settings: AdjustmentSettings): boolean {
  return settings.brightness === 100 && settings.contrast === 100 && settings.saturation === 100
    && settings.hue === 0 && settings.temperature === 0 && settings.style === 'none'
}

/** RGB edits leave alpha intact; blur is applied separately in premultiplied canvas space. */
export function adjustPixelData(data: Uint8ClampedArray, settings: AdjustmentSettings): void {
  const angle = settings.hue * Math.PI / 180
  const cosine = Math.cos(angle), sine = Math.sin(angle)
  const brightness = settings.brightness / 100, contrast = settings.contrast / 100
  const saturation = settings.saturation / 100, warmth = settings.temperature * 0.45
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    let r = data[i] * brightness, g = data[i + 1] * brightness, b = data[i + 2] * brightness
    r = (r - 128) * contrast + 128
    g = (g - 128) * contrast + 128
    b = (b - 128) * contrast + 128
    const gray = r * 0.213 + g * 0.715 + b * 0.072
    r = gray + (r - gray) * saturation
    g = gray + (g - gray) * saturation
    b = gray + (b - gray) * saturation
    if (settings.hue !== 0) {
      const nr = (0.213 + cosine * 0.787 - sine * 0.213) * r + (0.715 - cosine * 0.715 - sine * 0.715) * g + (0.072 - cosine * 0.072 + sine * 0.928) * b
      const ng = (0.213 - cosine * 0.213 + sine * 0.143) * r + (0.715 + cosine * 0.285 + sine * 0.140) * g + (0.072 - cosine * 0.072 - sine * 0.283) * b
      b = (0.213 - cosine * 0.213 - sine * 0.787) * r + (0.715 - cosine * 0.715 + sine * 0.715) * g + (0.072 + cosine * 0.928 + sine * 0.072) * b
      r = nr; g = ng
    }
    r += warmth; g += warmth * 0.08; b -= warmth
    if (settings.style === 'grayscale' || settings.style === 'noir') {
      const value = r * 0.213 + g * 0.715 + b * 0.072
      r = g = b = settings.style === 'noir' ? (value - 128) * 1.55 + 128 : value
    } else if (settings.style === 'sepia' || settings.style === 'vintage') {
      const nr = r * 0.393 + g * 0.769 + b * 0.189
      const ng = r * 0.349 + g * 0.686 + b * 0.168
      const nb = r * 0.272 + g * 0.534 + b * 0.131
      const mix = settings.style === 'vintage' ? 0.55 : 1
      r += (nr - r) * mix; g += (ng - g) * mix; b += (nb - b) * mix
      if (settings.style === 'vintage') { r = (r - 128) * 0.85 + 136; g = (g - 128) * 0.85 + 132; b = (b - 128) * 0.85 + 124 }
    }
    data[i] = r; data[i + 1] = g; data[i + 2] = b
  }
}

export type AdjustmentResult = { layerId: string; before: TileSnapshot; after: TileSnapshot }

function intersectsTile(tx: number, ty: number, selection: Rect | null, offset: { x: number; y: number }): boolean {
  if (!selection) return true
  const x = tx * TILE_SIZE + offset.x, y = ty * TILE_SIZE + offset.y
  return selection.x < x + TILE_SIZE && selection.x + selection.width > x
    && selection.y < y + TILE_SIZE && selection.y + selection.height > y
}

export function adjustmentEditArea(tx: number, ty: number, selection: Rect | null, offset: { x: number; y: number }) {
  if (!selection) return { x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE }
  const x = tx * TILE_SIZE + offset.x, y = ty * TILE_SIZE + offset.y
  const left = Math.max(0, Math.ceil(selection.x - x))
  const top = Math.max(0, Math.ceil(selection.y - y))
  const right = Math.min(TILE_SIZE, Math.ceil(selection.x + selection.width - x))
  const bottom = Math.min(TILE_SIZE, Math.ceil(selection.y + selection.height - y))
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/** Edits visible layers without flattening them. Each tile samples the original layer, so blur has no tile seams. */
export function applyAdjustments(layers: CanvasLayer[], selection: Rect | null, settings: AdjustmentSettings, pixelSelection: PixelSelection | null = null): AdjustmentResult[] {
  if (adjustmentsAreNeutral(settings)) return []
  const results: AdjustmentResult[] = []
  const pending: Array<{ layer: CanvasLayer; tiles: Map<string, HTMLCanvasElement> }> = []
  const padding = Math.ceil(settings.blur * 3)
  for (const layer of layers) {
    if (!layer.visible || layer.locked || layer.textSource || layer.tiles.size === 0) continue
    const candidates = new Set<string>()
    for (const key of layer.tiles.keys()) {
      const [sourceX, sourceY] = key.split(',').map(Number)
      const reach = padding > 0 ? 1 : 0
      for (let ty = sourceY - reach; ty <= sourceY + reach; ty++) for (let tx = sourceX - reach; tx <= sourceX + reach; tx++) {
        if (intersectsTile(tx, ty, selection, layer.offset)) candidates.add(tileKey(tx, ty))
      }
    }
    const before: TileSnapshot = new Map(), after: TileSnapshot = new Map()
    const replacements = new Map<string, HTMLCanvasElement>()
    for (const key of candidates) {
      const [tx, ty] = key.split(',').map(Number)
      const area = adjustmentEditArea(tx, ty, selection, layer.offset)
      if (!area.width || !area.height) continue
      const source = rasterizeRegion([rawLayer(layer)], {
        x: tx * TILE_SIZE + layer.offset.x - padding, y: ty * TILE_SIZE + layer.offset.y - padding,
        width: TILE_SIZE + padding * 2, height: TILE_SIZE + padding * 2,
      }, TILE_SIZE + padding * 2, TILE_SIZE + padding * 2)
      if (!colorAdjustmentsAreNeutral(settings)) {
        const sourceContext = source.getContext('2d')!
        const sourcePixels = sourceContext.getImageData(0, 0, source.width, source.height)
        adjustPixelData(sourcePixels.data, settings)
        sourceContext.putImageData(sourcePixels, 0, 0)
      }
      let processed = source
      if (settings.blur > 0) {
        processed = document.createElement('canvas')
        processed.width = source.width; processed.height = source.height
        const context = processed.getContext('2d')!
        context.filter = `blur(${settings.blur}px)`
        context.drawImage(source, 0, 0)
      }
      const pixels = processed.getContext('2d')!.getImageData(padding, padding, TILE_SIZE, TILE_SIZE)
      const original = captureTile(layer, key)
      if (pixelSelection) {
        const mask = selectionMask(pixelSelection, { x: tx * TILE_SIZE + layer.offset.x, y: ty * TILE_SIZE + layer.offset.y, width: TILE_SIZE, height: TILE_SIZE })
        blendSelectionPixels(pixels, original ?? { width: TILE_SIZE, height: TILE_SIZE, data: new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4) } as ImageData,
          mask.getContext('2d')!.getImageData(0, 0, TILE_SIZE, TILE_SIZE))
      }
      let changed = false
      for (let y = area.y; y < area.y + area.height && !changed; y++) for (let x = area.x; x < area.x + area.width; x++) {
        const index = (y * TILE_SIZE + x) * 4
        for (let channel = 0; channel < 4; channel++) if (pixels.data[index + channel] !== (original?.data[index + channel] ?? 0)) { changed = true; break }
        if (changed) break
      }
      if (!changed) continue
      const tile = document.createElement('canvas'); tile.width = TILE_SIZE; tile.height = TILE_SIZE
      const context = tile.getContext('2d')!
      if (original) context.putImageData(original, 0, 0)
      context.putImageData(pixels, 0, 0, area.x, area.y, area.width, area.height)
      before.set(key, original); after.set(key, context.getImageData(0, 0, TILE_SIZE, TILE_SIZE))
      replacements.set(key, tile)
    }
    if (replacements.size) {
      pending.push({ layer, tiles: replacements })
      results.push({ layerId: layer.id, before, after })
    }
  }
  for (const { layer, tiles } of pending) for (const [key, tile] of tiles) layer.tiles.set(key, tile)
  return results
}

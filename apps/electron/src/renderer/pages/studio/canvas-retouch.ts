import { MAX_RASTER_SIDE, TILE_SIZE, captureTile, createLayer, drawImageOnLayer, getTile, normalizeRect, paintSegment, rasterizeRegion, tileKey, tileRange, unionRects, type CanvasLayer, type Point, type Rect, type TileSnapshot } from './canvas-engine'

/** White alpha is selected. Bounds and paths always use canvas world coordinates. */
export type PixelSelection = { bounds: Rect; mask: HTMLCanvasElement; kind: 'ellipse' | 'lasso' | 'brush' | 'wand' | 'mixed' }
export type SelectionMode = 'replace' | 'add' | 'subtract' | 'intersect'

function canvas(width: number, height: number): HTMLCanvasElement {
  const result = document.createElement('canvas')
  result.width = Math.max(1, Math.ceil(width)); result.height = Math.max(1, Math.ceil(height))
  return result
}

export function checkedSelectionBounds(rect: Rect): Rect {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || Math.abs(rect.x) > 1_000_000_000 || Math.abs(rect.y) > 1_000_000_000 || rect.width <= 0 || rect.height <= 0) throw new Error('选区坐标或尺寸无效')
  const x = Math.floor(rect.x), y = Math.floor(rect.y)
  const bounds = { x, y, width: Math.ceil(rect.x + rect.width) - x, height: Math.ceil(rect.y + rect.height) - y }
  if (bounds.width > MAX_RASTER_SIDE || bounds.height > MAX_RASTER_SIDE) throw new Error('精细选区单边最多 4096 像素，请分区域操作')
  return bounds
}

export function pathBounds(points: Point[], margin = 0): Rect {
  if (!points.length || points.length > 2000 || !points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) throw new Error('路径需要 1–2000 个有效坐标点')
  const xs = points.map(p => p.x), ys = points.map(p => p.y)
  return checkedSelectionBounds({ x: Math.min(...xs) - margin, y: Math.min(...ys) - margin,
    width: Math.max(1, Math.max(...xs) - Math.min(...xs)) + margin * 2,
    height: Math.max(1, Math.max(...ys) - Math.min(...ys)) + margin * 2 })
}

export function shapeSelection(points: Point[], kind: 'lasso' | 'brush' | 'ellipse', brush = 18): PixelSelection {
  if (!Number.isFinite(brush) || brush < 1 || brush > 160) throw new Error('笔刷大小需要在 1–160 像素内')
  if (!points.length || !points.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))) throw new Error('选区路径无效')
  if (kind === 'lasso' && points.length < 3) throw new Error('套索需要至少 3 个坐标点')
  const bounds = kind === 'ellipse' ? checkedSelectionBounds(normalizeRect(points[0], points[points.length - 1])) : pathBounds(points, kind === 'brush' ? brush / 2 + 1 : 1)
  const mask = canvas(bounds.width, bounds.height), ctx = mask.getContext('2d')!
  ctx.translate(-bounds.x, -bounds.y); ctx.fillStyle = ctx.strokeStyle = '#fff'
  ctx.beginPath()
  if (kind === 'ellipse') ctx.ellipse(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, bounds.width / 2, bounds.height / 2, 0, 0, Math.PI * 2)
  else {
    ctx.moveTo(points[0].x, points[0].y)
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y)
  }
  if (kind === 'brush') {
    ctx.lineWidth = brush; ctx.lineCap = ctx.lineJoin = 'round'; ctx.stroke()
    ctx.beginPath(); ctx.arc(points[0].x, points[0].y, brush / 2, 0, Math.PI * 2); ctx.fill()
  } else { ctx.closePath(); ctx.fill() }
  return { bounds, mask, kind }
}

export function selectionMask(selection: PixelSelection | null, rect: Rect, width = Math.ceil(rect.width), height = Math.ceil(rect.height)): HTMLCanvasElement {
  const mask = canvas(width, height), ctx = mask.getContext('2d')!
  if (!selection) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, mask.width, mask.height) }
  else {
    const b = selection.bounds
    ctx.drawImage(selection.mask, (b.x - rect.x) / rect.width * width, (b.y - rect.y) / rect.height * height, b.width / rect.width * width, b.height / rect.height * height)
  }
  return mask
}

export function rectangularSelection(rect: Rect): PixelSelection {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || Math.abs(rect.x) > 1_000_000_000 || Math.abs(rect.y) > 1_000_000_000) throw new Error('选区坐标或尺寸无效')
  return { bounds: { ...rect }, mask: selectionMask(null, rect, 1, 1), kind: 'mixed' }
}

export function trimSelection(selection: PixelSelection): PixelSelection | null {
  const pixels = selection.mask.getContext('2d')!.getImageData(0, 0, selection.mask.width, selection.mask.height)
  let left = pixels.width, top = pixels.height, right = 0, bottom = 0
  for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) if (pixels.data[(y * pixels.width + x) * 4 + 3]) {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1)
  }
  if (!right || !bottom) return null
  if (!left && !top && right === pixels.width && bottom === pixels.height) return selection
  const scaleX = selection.bounds.width / pixels.width, scaleY = selection.bounds.height / pixels.height
  const bounds = { x: selection.bounds.x + left * scaleX, y: selection.bounds.y + top * scaleY, width: (right - left) * scaleX, height: (bottom - top) * scaleY }
  const mask = canvas(right - left, bottom - top)
  mask.getContext('2d')!.drawImage(selection.mask, left, top, right - left, bottom - top, 0, 0, mask.width, mask.height)
  return { ...selection, bounds, mask }
}

export function combineSelections(previous: PixelSelection | null, next: PixelSelection, mode: SelectionMode): PixelSelection | null {
  if (mode === 'replace' || !previous && mode === 'add') return trimSelection(next)
  if (!previous) return null
  const bounds = checkedSelectionBounds(mode === 'add' ? unionRects(previous.bounds, next.bounds)! : previous.bounds)
  const mask = selectionMask(previous, bounds), ctx = mask.getContext('2d')!
  const incoming = selectionMask(next, bounds)
  const pixels = ctx.getImageData(0, 0, mask.width, mask.height), added = incoming.getContext('2d')!.getImageData(0, 0, mask.width, mask.height)
  for (let i = 0; i < pixels.data.length; i += 4) {
    const a = pixels.data[i + 3], b = added.data[i + 3]
    pixels.data.fill(255, i, i + 3)
    pixels.data[i + 3] = mode === 'add' ? Math.max(a, b) : mode === 'subtract' ? Math.max(0, a - b) : Math.min(a, b)
  }
  ctx.putImageData(pixels, 0, 0)
  return trimSelection({ bounds, mask, kind: 'mixed' })
}

export function invertSelection(selection: PixelSelection): PixelSelection {
  const bounds = checkedSelectionBounds(selection.bounds)
  const mask = selectionMask(null, bounds), ctx = mask.getContext('2d')!
  ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(selectionMask(selection, bounds), 0, 0)
  return { bounds, mask, kind: 'mixed' }
}

/** Connected flood fill includes alpha distance so transparent pixels do not select opaque black. */
export function contiguousColorMask(image: ImageData, seed: Point, tolerance: number): Uint8ClampedArray {
  const { width, height, data } = image, result = new Uint8ClampedArray(width * height)
  const x = Math.floor(seed.x), y = Math.floor(seed.y)
  if (x < 0 || y < 0 || x >= width || y >= height) return result
  const initial = y * width + x, start = initial * 4
  const seen = new Uint8Array(width * height), queue = new Uint32Array(width * height)
  let head = 0, tail = 0
  const visit = (index: number) => {
    if (seen[index]) return
    seen[index] = 1
    const offset = index * 4
    for (let channel = 0; channel < 4; channel++) if (Math.abs(data[offset + channel] - data[start + channel]) > tolerance) return
    queue[tail++] = index; result[index] = 255
  }
  visit(initial)
  while (head < tail) {
    const index = queue[head++], column = index % width
    if (column > 0) visit(index - 1)
    if (column + 1 < width) visit(index + 1)
    if (index >= width) visit(index - width)
    if (index + width < result.length) visit(index + width)
  }
  return result
}

export function wandSelection(layer: CanvasLayer, seed: Point, tolerance: number, bounds: Rect): PixelSelection {
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) throw new Error('容差需要在 0–100 内')
  bounds = checkedSelectionBounds(bounds)
  const source = rasterizeRegion([{ ...layer, visible: true, opacity: 1 }], bounds, bounds.width, bounds.height)
  const ctx = source.getContext('2d')!, image = ctx.getImageData(0, 0, source.width, source.height)
  const alpha = contiguousColorMask(image, { x: seed.x - bounds.x, y: seed.y - bounds.y }, tolerance)
  for (let i = 0; i < alpha.length; i++) { image.data.fill(255, i * 4, i * 4 + 3); image.data[i * 4 + 3] = alpha[i] }
  ctx.putImageData(image, 0, 0)
  return { bounds, mask: source, kind: 'wand' }
}

/** Replace pixels with premultiplied alpha, retaining every unselected pixel exactly. */
export function blendSelectionPixels(result: ImageData, original: ImageData, mask: ImageData): void {
  if (result.width !== original.width || result.height !== original.height || result.width !== mask.width || result.height !== mask.height) throw new Error('选区遮罩尺寸不一致')
  for (let i = 0; i < result.data.length; i += 4) {
    const weight = mask.data[i + 3] / 255
    if (weight === 1) continue
    if (!weight) { result.data.set(original.data.subarray(i, i + 4), i); continue }
    const a = original.data[i + 3] / 255 * (1 - weight), b = result.data[i + 3] / 255 * weight, alpha = a + b
    for (let channel = 0; channel < 3; channel++) result.data[i + channel] = alpha ? (original.data[i + channel] * a + result.data[i + channel] * b) / alpha : 0
    result.data[i + 3] = alpha * 255
  }
}

export function clearMaskedSelection(layer: CanvasLayer, selection: PixelSelection, before: TileSnapshot): void {
  for (const [key, tile] of layer.tiles) {
    const [tx, ty] = key.split(',').map(Number)
    const rect = { x: tx * TILE_SIZE + layer.offset.x, y: ty * TILE_SIZE + layer.offset.y, width: TILE_SIZE, height: TILE_SIZE }
    const b = selection.bounds
    if (rect.x >= b.x + b.width || rect.x + rect.width <= b.x || rect.y >= b.y + b.height || rect.y + rect.height <= b.y) continue
    if (!before.has(key)) before.set(key, captureTile(layer, key))
    const ctx = tile.getContext('2d')!
    ctx.save(); ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(selectionMask(selection, rect), 0, 0); ctx.restore()
  }
}

export function drawMaskedImage(layer: CanvasLayer, image: CanvasImageSource, rect: Rect, selection: PixelSelection | null, before?: TileSnapshot, replace = false): void {
  if (!selection && !replace) { drawImageOnLayer(layer, image, rect, before); return }
  const range = tileRange({ ...rect, x: rect.x - layer.offset.x, y: rect.y - layer.offset.y })
  for (let ty = range.top; ty <= range.bottom; ty++) for (let tx = range.left; tx <= range.right; tx++) {
    const key = tileKey(tx, ty), world = { x: tx * TILE_SIZE + layer.offset.x, y: ty * TILE_SIZE + layer.offset.y, width: TILE_SIZE, height: TILE_SIZE }
    const overlay = canvas(TILE_SIZE, TILE_SIZE), ctx = overlay.getContext('2d')!
    ctx.drawImage(image, rect.x - world.x, rect.y - world.y, rect.width, rect.height)
    const mask = selectionMask(selection, world)
    // Clamp the mask to the image frame even when replacing partial tiles.
    const mctx = mask.getContext('2d')!
    mctx.globalCompositeOperation = 'destination-in'; mctx.fillStyle = '#fff'
    const frame = canvas(TILE_SIZE, TILE_SIZE), fctx = frame.getContext('2d')!
    fctx.fillRect(rect.x - world.x, rect.y - world.y, rect.width, rect.height); mctx.drawImage(frame, 0, 0)
    const maskPixels = mctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE)
    let hasPixels = false
    for (let i = 3; i < maskPixels.data.length; i += 4) if (maskPixels.data[i]) { hasPixels = true; break }
    if (!hasPixels) continue
    if (!before?.has(key)) before?.set(key, captureTile(layer, key))
    const destination = getTile(layer, tx, ty).getContext('2d')!
    if (replace) {
      const pixels = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE)
      blendSelectionPixels(pixels, destination.getImageData(0, 0, TILE_SIZE, TILE_SIZE), maskPixels)
      destination.putImageData(pixels, 0, 0)
    } else {
      ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(mask, 0, 0); destination.drawImage(overlay, 0, 0)
    }
  }
}

export function paintMaskedSegment(layer: CanvasLayer, from: Point, to: Point, width: number, color: string, erase: boolean, before: TileSnapshot, selection: PixelSelection | null): void {
  if (!selection) { paintSegment(layer, from, to, width, color, erase, before); return }
  const temporary = createLayer(); temporary.offset = { ...layer.offset }
  paintSegment(temporary, from, to, width, color, false, new Map())
  for (const [key, tile] of temporary.tiles) {
    const [tx, ty] = key.split(',').map(Number), rect = { x: tx * TILE_SIZE + layer.offset.x, y: ty * TILE_SIZE + layer.offset.y, width: TILE_SIZE, height: TILE_SIZE }
    if (erase && !layer.tiles.has(key)) continue
    const ctx = tile.getContext('2d')!
    ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(selectionMask(selection, rect), 0, 0)
    const pixels = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data
    let hasPixels = false
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) { hasPixels = true; break }
    if (!hasPixels) continue
    if (!before.has(key)) before.set(key, captureTile(layer, key))
    const target = getTile(layer, tx, ty).getContext('2d')!
    target.save(); target.globalCompositeOperation = erase ? 'destination-out' : 'source-over'; target.drawImage(tile, 0, 0); target.restore()
  }
}

export function snapshotLayer(layer: CanvasLayer): CanvasLayer {
  const result = { ...layer, visible: true, opacity: 1, offset: { ...layer.offset }, tiles: new Map<string, HTMLCanvasElement>() }
  for (const [key, tile] of layer.tiles) { const copy = canvas(TILE_SIZE, TILE_SIZE); copy.getContext('2d')!.drawImage(tile, 0, 0); result.tiles.set(key, copy) }
  return result
}

export function cloneSegment(layer: CanvasLayer, source: CanvasLayer, from: Point, to: Point, delta: Point, width: number, before: TileSnapshot, selection: PixelSelection | null): void {
  if (!Number.isFinite(width) || width < 1 || width > 160) throw new Error('笔刷大小需要在 1–160 像素内')
  checkedSelectionBounds({ x: Math.min(from.x, to.x) + delta.x - width / 2, y: Math.min(from.y, to.y) + delta.y - width / 2,
    width: Math.abs(to.x - from.x) + width, height: Math.abs(to.y - from.y) + width })
  const distance = Math.hypot(to.x - from.x, to.y - from.y), steps = Math.max(1, Math.ceil(distance / Math.max(1, width / 4)))
  for (let step = distance ? 1 : 0; step <= steps; step++) {
    const point = { x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps }
    const rect = { x: point.x - width / 2, y: point.y - width / 2, width, height: width }
    const stamp = rasterizeRegion([source], { ...rect, x: rect.x + delta.x, y: rect.y + delta.y }, Math.ceil(width), Math.ceil(width))
    const ctx = stamp.getContext('2d')!, circle = shapeSelection([{ x: rect.x, y: rect.y }, { x: rect.x + width, y: rect.y + width }], 'ellipse')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(selectionMask(circle, rect, stamp.width, stamp.height), 0, 0)
    drawMaskedImage(layer, stamp, rect, selection, before)
    if (!distance) break
  }
}

export function sampleColor(layers: CanvasLayer[], point: Point): { color: string; alpha: number } {
  checkedSelectionBounds({ ...point, width: 1, height: 1 })
  const pixel = rasterizeRegion(layers, { x: Math.floor(point.x), y: Math.floor(point.y), width: 1, height: 1 }, 1, 1).getContext('2d')!.getImageData(0, 0, 1, 1).data
  return { color: `#${[...pixel.subarray(0, 3)].map(value => value.toString(16).padStart(2, '0')).join('')}`, alpha: pixel[3] / 255 }
}

export const TILE_SIZE = 512
export const MAX_RASTER_SIDE = 4096

export type Point = { x: number; y: number }
export type Rect = { x: number; y: number; width: number; height: number }
export type CanvasTool = 'move' | 'hand' | 'select' | 'brush' | 'erase' | 'adjust' | 'ai'
export type CanvasLayer = {
  id: string
  name: string
  visible: boolean
  opacity: number
  offset: Point
  tiles: Map<string, HTMLCanvasElement>
}
export type TileSnapshot = Map<string, ImageData | null>

export function createLayer(name = '图层 1'): CanvasLayer {
  return { id: crypto.randomUUID(), name, visible: true, opacity: 1, offset: { x: 0, y: 0 }, tiles: new Map() }
}

export function normalizeRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

export function tileKey(x: number, y: number): string { return `${x},${y}` }

export function tileRange(rect: Rect): { left: number; top: number; right: number; bottom: number } {
  return {
    left: Math.floor(rect.x / TILE_SIZE),
    top: Math.floor(rect.y / TILE_SIZE),
    right: Math.ceil((rect.x + Math.max(rect.width, 0.001)) / TILE_SIZE) - 1,
    bottom: Math.ceil((rect.y + Math.max(rect.height, 0.001)) / TILE_SIZE) - 1,
  }
}

export function unionRects(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b
  if (!b) return a
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: right - Math.min(a.x, b.x), height: bottom - Math.min(a.y, b.y) }
}

export function layerBounds(layer: CanvasLayer): Rect | null {
  let result: Rect | null = null
  for (const key of layer.tiles.keys()) {
    const [tx, ty] = key.split(',').map(Number)
    result = unionRects(result, { x: tx * TILE_SIZE + layer.offset.x, y: ty * TILE_SIZE + layer.offset.y, width: TILE_SIZE, height: TILE_SIZE })
  }
  return result
}

/** Scan populated pixels only when an export or edit needs a tight crop. */
export function layerPixelBounds(layer: CanvasLayer): Rect | null {
  let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity
  for (const [key, tile] of layer.tiles) {
    const [tx, ty] = key.split(',').map(Number)
    const data = tile.getContext('2d')!.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data
    for (let y = 0; y < TILE_SIZE; y++) for (let x = 0; x < TILE_SIZE; x++) {
      if (data[(y * TILE_SIZE + x) * 4 + 3] === 0) continue
      const px = tx * TILE_SIZE + x + layer.offset.x
      const py = ty * TILE_SIZE + y + layer.offset.y
      left = Math.min(left, px); top = Math.min(top, py)
      right = Math.max(right, px + 1); bottom = Math.max(bottom, py + 1)
    }
  }
  return left === Infinity ? null : { x: left, y: top, width: right - left, height: bottom - top }
}

export function contentPixelBounds(layers: CanvasLayer[]): Rect | null {
  return layers.reduce<Rect | null>((bounds, layer) => layer.visible
    ? unionRects(bounds, layerPixelBounds(layer)) : bounds, null)
}

export function contentBounds(layers: CanvasLayer[], visibleOnly = true): Rect | null {
  return layers.reduce<Rect | null>((bounds, layer) =>
    visibleOnly && !layer.visible ? bounds : unionRects(bounds, layerBounds(layer)), null)
}

export function getTile(layer: CanvasLayer, tx: number, ty: number): HTMLCanvasElement {
  const key = tileKey(tx, ty)
  let tile = layer.tiles.get(key)
  if (!tile) {
    tile = document.createElement('canvas')
    tile.width = TILE_SIZE
    tile.height = TILE_SIZE
    layer.tiles.set(key, tile)
  }
  return tile
}

export function captureTile(layer: CanvasLayer, key: string): ImageData | null {
  const tile = layer.tiles.get(key)
  return tile?.getContext('2d')?.getImageData(0, 0, TILE_SIZE, TILE_SIZE) ?? null
}

export function restoreTiles(layer: CanvasLayer, snapshots: TileSnapshot): void {
  for (const [key, image] of snapshots) {
    if (!image) { layer.tiles.delete(key); continue }
    const [tx, ty] = key.split(',').map(Number)
    getTile(layer, tx, ty).getContext('2d')!.putImageData(image, 0, 0)
  }
}

export function paintSegment(
  layer: CanvasLayer, from: Point, to: Point, width: number, color: string, erase: boolean,
  before: TileSnapshot,
): void {
  const a = { x: from.x - layer.offset.x, y: from.y - layer.offset.y }
  const b = { x: to.x - layer.offset.x, y: to.y - layer.offset.y }
  const margin = width / 2 + 2
  const range = tileRange({
    x: Math.min(a.x, b.x) - margin, y: Math.min(a.y, b.y) - margin,
    width: Math.abs(a.x - b.x) + margin * 2, height: Math.abs(a.y - b.y) + margin * 2,
  })
  for (let ty = range.top; ty <= range.bottom; ty++) for (let tx = range.left; tx <= range.right; tx++) {
    const key = tileKey(tx, ty)
    if (erase && !layer.tiles.has(key)) continue
    if (!before.has(key)) before.set(key, captureTile(layer, key))
    const ctx = getTile(layer, tx, ty).getContext('2d')!
    ctx.save()
    ctx.translate(-tx * TILE_SIZE, -ty * TILE_SIZE)
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = width
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    if (a.x === b.x && a.y === b.y) {
      ctx.beginPath()
      ctx.arc(a.x, a.y, width / 2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }
}

export function drawImageOnLayer(layer: CanvasLayer, image: CanvasImageSource, rect: Rect, before?: TileSnapshot): void {
  const local = { ...rect, x: rect.x - layer.offset.x, y: rect.y - layer.offset.y }
  const range = tileRange(local)
  for (let ty = range.top; ty <= range.bottom; ty++) for (let tx = range.left; tx <= range.right; tx++) {
    const key = tileKey(tx, ty)
    if (before && !before.has(key)) before.set(key, captureTile(layer, key))
    const ctx = getTile(layer, tx, ty).getContext('2d')!
    ctx.drawImage(image, local.x - tx * TILE_SIZE, local.y - ty * TILE_SIZE, local.width, local.height)
  }
}

export function clearLayerRect(layer: CanvasLayer, rect: Rect, before?: TileSnapshot): void {
  const local = { ...rect, x: rect.x - layer.offset.x, y: rect.y - layer.offset.y }
  const range = tileRange(local)
  for (let ty = range.top; ty <= range.bottom; ty++) for (let tx = range.left; tx <= range.right; tx++) {
    const key = tileKey(tx, ty)
    const tile = layer.tiles.get(key)
    if (!tile) continue
    if (before && !before.has(key)) before.set(key, captureTile(layer, key))
    tile.getContext('2d')!.clearRect(local.x - tx * TILE_SIZE, local.y - ty * TILE_SIZE, local.width, local.height)
  }
}

export function drawLayers(ctx: CanvasRenderingContext2D, layers: CanvasLayer[], viewport: Rect): void {
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue
    ctx.save()
    ctx.globalAlpha = layer.opacity
    const local = { ...viewport, x: viewport.x - layer.offset.x, y: viewport.y - layer.offset.y }
    const range = tileRange(local)
    for (let ty = range.top; ty <= range.bottom; ty++) for (let tx = range.left; tx <= range.right; tx++) {
      const tile = layer.tiles.get(tileKey(tx, ty))
      if (tile) ctx.drawImage(tile, tx * TILE_SIZE + layer.offset.x, ty * TILE_SIZE + layer.offset.y)
    }
    ctx.restore()
  }
}

export function rasterizeRegion(layers: CanvasLayer[], rect: Rect, outputWidth: number, outputHeight: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = outputWidth
  canvas.height = outputHeight
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(outputWidth / rect.width, 0, 0, outputHeight / rect.height,
    -rect.x * outputWidth / rect.width, -rect.y * outputHeight / rect.height)
  drawLayers(ctx, layers, rect)
  return canvas
}

export function removeEdgeBackground(image: ImageData, tolerance: number): number {
  const { data, width, height } = image
  const length = width * height
  const visited = new Uint8Array(length)
  const queue = new Uint32Array(length)
  const edge: number[] = []
  for (let x = 0; x < width; x++) { edge.push(x, (height - 1) * width + x) }
  for (let y = 1; y < height - 1; y++) { edge.push(y * width, y * width + width - 1) }
  const buckets = new Map<string, { count: number; color: [number, number, number] }>()
  for (const index of edge) {
    const start = index * 4
    if (data[start + 3] < 32) continue
    const key = `${data[start] >> 4},${data[start + 1] >> 4},${data[start + 2] >> 4}`
    const entry = buckets.get(key)
    if (entry) entry.count++
    else buckets.set(key, { count: 1, color: [data[start], data[start + 1], data[start + 2]] })
  }
  const background = [...buckets.values()].sort((a, b) => b.count - a.count)[0]?.color
  if (!background) return 0
  let head = 0; let tail = 0; let removed = 0
  const matches = (index: number) => {
    const start = index * 4
    return data[start + 3] >= 32 && Math.max(
      Math.abs(data[start] - background[0]), Math.abs(data[start + 1] - background[1]), Math.abs(data[start + 2] - background[2]),
    ) <= tolerance
  }
  const enqueue = (index: number) => {
    if (visited[index]) return
    visited[index] = 1
    if (matches(index)) queue[tail++] = index
  }
  for (const index of edge) enqueue(index)
  while (head < tail) {
    const index = queue[head++]
    if (data[index * 4 + 3]) { data[index * 4 + 3] = 0; removed++ }
    const x = index % width
    if (x > 0) enqueue(index - 1)
    if (x < width - 1) enqueue(index + 1)
    if (index >= width) enqueue(index - width)
    if (index < length - width) enqueue(index + width)
  }
  return removed
}

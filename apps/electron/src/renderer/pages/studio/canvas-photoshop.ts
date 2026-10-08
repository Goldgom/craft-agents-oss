import { BLEND_MODES, TILE_SIZE, assertPixelEditable, captureTile, contentPixelBounds, createLayer, drawImageOnLayer, layerMaskImage, layerPixelBounds, rasterizeRegion, rawLayer, unionRects, type CanvasLayer, type LayerMask, type Point, type Rect, type TextSource, type TileSnapshot } from './canvas-engine'
import { blendSelectionPixels, checkedSelectionBounds, clearMaskedSelection, combineSelections, drawMaskedImage, rectangularSelection, selectionMask, shapeSelection, type PixelSelection } from './canvas-retouch'
import { applyDrawingCommand } from './canvas-drawing'

export const photoshopActions = ['set_document', 'resize_document', 'crop_document', 'select_all', 'modify_selection', 'set_layer_mask', 'paint_layer_mask', 'apply_layer_mask', 'group_layers', 'set_group', 'align_layers', 'flatten_layers', 'copy_pixels', 'cut_pixels', 'paste_pixels', 'add_text_layer', 'edit_text_layer', 'rasterize_layer', 'filter', 'export_image', 'set_guides', 'get_history', 'heal_stamp', 'select_polygon', 'retouch_brush', 'fill_selection', 'stroke_selection'] as const
export type DocumentSettings = { bounds: Rect | null; background: string; guides: Array<{ axis: 'x' | 'y'; value: number }>; grid: boolean; snap: boolean }
export const defaultDocument = (): DocumentSettings => ({ bounds: null, background: 'transparent', guides: [], grid: true, snap: false })
export const FILTERS = ['levels', 'curves', 'color-balance', 'invert', 'threshold', 'posterize', 'sharpen', 'noise', 'blur'] as const
export type FilterName = typeof FILTERS[number]
export type FilterOptions = { filter: FilterName; amount?: number; black?: number; white?: number; gamma?: number; red?: number; green?: number; blue?: number; curve?: Point[]; seed?: number }

export function canvasImage(width: number, height: number): HTMLCanvasElement {
  const image = document.createElement('canvas'); image.width = width; image.height = height; return image
}
export function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const image = canvasImage(source.width, source.height); image.getContext('2d')!.drawImage(source, 0, 0); return image
}
export function copyLayer(layer: CanvasLayer, newId = false): CanvasLayer {
  return { ...layer, id: newId ? crypto.randomUUID() : layer.id, offset: { ...layer.offset }, tiles: new Map([...layer.tiles].map(([key, image]) => [key, cloneCanvas(image)])),
    mask: layer.mask ? { ...layer.mask, bounds: { ...layer.mask.bounds }, canvas: cloneCanvas(layer.mask.canvas) } : undefined,
    textSource: layer.textSource ? { ...layer.textSource, matrix: [...layer.textSource.matrix] } : undefined }
}
export function validateDocument(input: unknown): DocumentSettings {
  if (!input || typeof input !== 'object') return defaultDocument()
  const doc = input as DocumentSettings
  const bounds = doc.bounds ? checkedSelectionBounds(doc.bounds) : null
  if (doc.background !== 'transparent' && !/^#[0-9a-f]{6}$/i.test(doc.background)) throw new Error('文档背景颜色无效')
  const guides = doc.guides ?? []
  if (!Array.isArray(guides) || guides.length > 100 || !guides.every(g => ['x', 'y'].includes(g.axis) && Number.isFinite(g.value) && Math.abs(g.value) <= 1e9)) throw new Error('参考线无效')
  return { bounds, background: doc.background, guides, grid: doc.grid !== false, snap: doc.snap === true }
}
export function snapPoint(point: Point, doc: DocumentSettings, distance: number): Point {
  if (!doc.snap) return point
  const result = { ...point }
  for (const axis of ['x', 'y'] as const) {
    const positions = doc.guides.filter(g => g.axis === axis).map(g => g.value)
    if (doc.bounds) positions.push(doc.bounds[axis], doc.bounds[axis] + (axis === 'x' ? doc.bounds.width : doc.bounds.height))
    const closest = positions.sort((a, b) => Math.abs(a - point[axis]) - Math.abs(b - point[axis]))[0]
    if (closest !== undefined && Math.abs(closest - point[axis]) <= distance) result[axis] = closest
  }
  return result
}

export function createMask(layer: CanvasLayer, selection: PixelSelection | null, mode: 'reveal' | 'hide' | 'selection'): LayerMask {
  if (layer.locked) throw new Error('当前图层已锁定')
  const bounds = checkedSelectionBounds(layerPixelBounds(layer) ?? selection?.bounds ?? { ...layer.offset, width: TILE_SIZE, height: TILE_SIZE })
  const canvas = mode === 'selection' ? selectionMask(selection ?? (() => { throw new Error('需要选区') })(), bounds) : canvasImage(bounds.width, bounds.height)
  if (mode === 'reveal') { const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height) }
  return { bounds: { ...bounds, x: bounds.x - layer.offset.x, y: bounds.y - layer.offset.y }, canvas, outside: mode === 'reveal' ? 1 : 0, enabled: true }
}
export function paintMask(layer: CanvasLayer, points: Point[], brush: number, reveal: boolean, selection: PixelSelection | null): LayerMask {
  if (layer.locked) throw new Error('当前图层已锁定')
  if (!layer.mask) throw new Error('请先添加图层蒙版')
  const current = layer.mask
  const stroke = shapeSelection(points, 'brush', brush)
  const combined = selection ? combineSelections(stroke, selection, 'intersect') : stroke
  if (!combined) return { ...current, canvas: cloneCanvas(current.canvas) }
  const world = checkedSelectionBounds(unionRects({ ...current.bounds, x: current.bounds.x + layer.offset.x, y: current.bounds.y + layer.offset.y }, combined.bounds)!)
  const image = layerMaskImage({ ...layer, mask: { ...current, enabled: true } }, world), ctx = image.getContext('2d')!, alpha = selectionMask(combined, world)
  if (reveal) { ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(alpha, 0, 0) }
  else { ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(alpha, 0, 0) }
  return { ...current, bounds: { ...world, x: world.x-layer.offset.x, y: world.y-layer.offset.y }, canvas: image }
}
export function applyMask(layer: CanvasLayer): CanvasLayer {
  if (layer.locked) throw new Error('当前图层已锁定')
  if (layer.alphaLocked) throw new Error('应用蒙版前请关闭透明度锁定')
  if (!layer.mask) throw new Error('当前图层没有蒙版')
  const next = copyLayer(layer); next.textSource = undefined
  for (const [key, image] of next.tiles) {
    const [tx, ty] = key.split(',').map(Number), ctx = image.getContext('2d')!
    ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(layerMaskImage(layer, { x: tx * TILE_SIZE + layer.offset.x, y: ty * TILE_SIZE + layer.offset.y, width: TILE_SIZE, height: TILE_SIZE }), 0, 0)
    ctx.globalCompositeOperation = 'source-over'
  }
  next.mask = undefined; return next
}

/** Morphology uses separable sliding extrema, remaining linear in selected pixels. */
function extremum(data: Uint8ClampedArray, width: number, height: number, radius: number, horizontal: boolean, maximum: boolean): Uint8ClampedArray {
  const output = new Uint8ClampedArray(data.length), length = horizontal ? width : height, count = horizontal ? height : width
  const queue = new Int32Array(length)
  for (let row = 0; row < count; row++) {
    let head = 0, tail = 0, next = 0
    const index = (position: number) => horizontal ? row * width + position : position * width + row
    for (let position = 0; position < length; position++) {
      while (next <= Math.min(length - 1, position + radius)) {
        while (tail > head && (maximum ? data[index(queue[tail - 1])] <= data[index(next)] : data[index(queue[tail - 1])] >= data[index(next)])) tail--
        queue[tail++] = next++
      }
      while (head < tail && queue[head] < position - radius) head++
      output[index(position)] = !maximum && (position < radius || position + radius >= length) ? 0 : data[index(queue[head])]
    }
  }
  return output
}
export function selectionMorphology(alpha: Uint8ClampedArray, width: number, height: number, radius: number, expand: boolean): Uint8ClampedArray {
  if (!Number.isInteger(radius) || radius < 1 || radius > 128 || alpha.length !== width * height) throw new Error('选区调整参数无效')
  return extremum(extremum(alpha, width, height, radius, true, expand), width, height, radius, false, expand)
}
export function modifySelection(selection: PixelSelection, operation: 'feather' | 'expand' | 'contract' | 'invert', radius: number, scope?: Rect | null): PixelSelection {
  if (!['feather', 'expand', 'contract', 'invert'].includes(operation) || !Number.isFinite(radius) || radius < 0 || radius > 128) throw new Error('选区调整参数无效')
  const b = selection.bounds, padding = operation === 'contract' ? 0 : operation === 'invert' ? 0 : Math.ceil(radius * (operation === 'feather' ? 3 : 1))
  const bounds = checkedSelectionBounds(operation === 'invert' ? scope ?? b : { x: b.x - padding, y: b.y - padding, width: b.width + padding * 2, height: b.height + padding * 2 })
  const mask = selectionMask(selection, bounds), ctx = mask.getContext('2d')!
  if (operation === 'feather') {
    const output = canvasImage(mask.width, mask.height), context = output.getContext('2d')!
    context.filter = `blur(${radius}px)`; context.drawImage(mask, 0, 0); return { bounds, mask: output, kind: 'mixed' }
  }
  const image = ctx.getImageData(0, 0, mask.width, mask.height)
  if (operation === 'invert') for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255 - image.data[i]
  else if (radius) {
    const alpha = new Uint8ClampedArray(mask.width * mask.height)
    for (let i = 0; i < alpha.length; i++) alpha[i] = image.data[i * 4 + 3]
    const changed = selectionMorphology(alpha, mask.width, mask.height, Math.ceil(radius), operation === 'expand')
    for (let i = 0; i < alpha.length; i++) image.data[i * 4 + 3] = changed[i]
  }
  for (let i = 0; i < image.data.length; i += 4) image.data.fill(255, i, i + 3)
  ctx.putImageData(image, 0, 0); return { bounds, mask, kind: 'mixed' }
}

function range(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback
  if (!Number.isFinite(result) || result < min || result > max) throw new Error('调整参数超出范围')
  return result
}
export function filterPixelData(image: ImageData, options: FilterOptions): void {
  if (!FILTERS.includes(options.filter)) throw new Error('不支持的滤镜')
  const { data, width, height } = image, source = options.filter === 'sharpen' ? data.slice() : data
  const amount = range(options.amount, options.filter === 'threshold' ? 128 : options.filter === 'posterize' ? 6 : 50, 0, options.filter === 'threshold' ? 255 : 100)
  const black = range(options.black, 0, 0, 254), white = range(options.white, 255, 1, 255), gamma = range(options.gamma, 1, 0.1, 10)
  if (black >= white) throw new Error('色阶黑点必须小于白点')
  const balance = [range(options.red, 0, -100, 100), range(options.green, 0, -100, 100), range(options.blue, 0, -100, 100)]
  const curve = options.curve ?? [{ x: 0, y: 0 }, { x: 255, y: 255 }]
  if (curve.length < 2 || curve.length > 32 || curve.some((p, i) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 255 || p.y < 0 || p.y > 255 || i > 0 && p.x <= curve[i - 1].x)) throw new Error('曲线坐标必须按输入值递增')
  const lut = new Uint8ClampedArray(256)
  for (let x = 0; x < 256; x++) {
    const right = curve.findIndex(p => p.x >= x)
    if (right <= 0) lut[x] = right === 0 ? curve[0].y : curve.at(-1)!.y
    else { const a = curve[right - 1], b = curve[right]; lut[x] = a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x) }
  }
  let seed = options.seed ?? 123456789
  if (!Number.isFinite(seed)) throw new Error('随机种子无效')
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue
    seed = Math.imul(seed ^ seed >>> 15, 1 | seed); seed ^= seed + Math.imul(seed ^ seed >>> 7, 61 | seed)
    const noise = ((seed ^ seed >>> 14) >>> 0) / 4294967296 * 2 - 1
    const gray = data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722
    for (let c = 0; c < 3; c++) {
      const value = source[i + c]
      if (options.filter === 'levels') data[i + c] = Math.pow(Math.max(0, Math.min(1, (value - black) / (white - black))), 1 / gamma) * 255
      else if (options.filter === 'curves') data[i + c] = lut[value]
      else if (options.filter === 'color-balance') data[i + c] = value + balance[c]
      else if (options.filter === 'invert') data[i + c] = 255 - value
      else if (options.filter === 'threshold') data[i + c] = gray >= amount ? 255 : 0
      else if (options.filter === 'posterize') { const levels = Math.max(2, Math.round(amount)); data[i + c] = Math.round(value / 255 * (levels - 1)) / (levels - 1) * 255 }
      else if (options.filter === 'noise') data[i + c] = value + noise * amount * 2.55
      else if (options.filter === 'sharpen') {
        const x = i / 4 % width, y = Math.floor(i / 4 / width)
        let sum = 0, weight = 0
        for (const [dx, dy] of [[0,-1],[-1,0],[1,0],[0,1]]) {
          const ni = (Math.max(0, Math.min(height - 1, y + dy)) * width + Math.max(0, Math.min(width - 1, x + dx))) * 4
          const alpha = source[ni + 3] / 255; sum += source[ni + c] * alpha; weight += alpha
        }
        data[i + c] = value + (value - (weight ? sum / weight : value)) * amount / 25
      }
    }
  }
}

export function filterLayer(layer: CanvasLayer, options: FilterOptions, selection: PixelSelection | null, before: TileSnapshot): void {
  assertPixelEditable(layer)
  if (!layer.visible) throw new Error('请先显示当前图层')
  if (!FILTERS.includes(options.filter)) throw new Error('不支持的滤镜')
  const padding = options.filter === 'sharpen' ? 1 : options.filter === 'blur' ? Math.ceil(range(options.amount, 3, 0, 24) * 3) : 0
  const pending: Array<{ key: string; image: HTMLCanvasElement }> = []
  for (const [key, tile] of layer.tiles) {
    const [tx, ty] = key.split(',').map(Number), rect = { x: tx * TILE_SIZE + layer.offset.x, y: ty * TILE_SIZE + layer.offset.y, width: TILE_SIZE, height: TILE_SIZE }
    if (selection && (selection.bounds.x >= rect.x + rect.width || selection.bounds.x + selection.bounds.width <= rect.x || selection.bounds.y >= rect.y + rect.height || selection.bounds.y + selection.bounds.height <= rect.y)) continue
    const source = rasterizeRegion([rawLayer(layer)], { x: rect.x - padding, y: rect.y - padding, width: TILE_SIZE + padding * 2, height: TILE_SIZE + padding * 2 }, TILE_SIZE + padding * 2, TILE_SIZE + padding * 2)
    let processed = source
    if (options.filter === 'blur') { processed = canvasImage(source.width, source.height); const ctx = processed.getContext('2d')!; ctx.filter = `blur(${range(options.amount, 3, 0, 24)}px)`; ctx.drawImage(source, 0, 0) }
    else { const ctx = source.getContext('2d')!, pixels = ctx.getImageData(0, 0, source.width, source.height); filterPixelData(pixels, options); ctx.putImageData(pixels, 0, 0) }
    const pixels = processed.getContext('2d')!.getImageData(padding, padding, TILE_SIZE, TILE_SIZE), original = tile.getContext('2d')!.getImageData(0, 0, TILE_SIZE, TILE_SIZE)
    // Retain alpha for these retouch filters, including a layer with transparency lock.
    for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = original.data[i]
    if (selection) blendSelectionPixels(pixels, original, selectionMask(selection, rect).getContext('2d')!.getImageData(0, 0, TILE_SIZE, TILE_SIZE))
    const output = canvasImage(TILE_SIZE, TILE_SIZE); output.getContext('2d')!.putImageData(pixels, 0, 0); pending.push({ key, image: output })
  }
  for (const { key, image } of pending) { if (!before.has(key)) before.set(key, captureTile(layer, key)); layer.tiles.set(key, image) }
}

export function retouchBrush(layer: CanvasLayer, points: Point[], brush: number, mode: 'blur'|'sharpen'|'smudge', strength: number, selection: PixelSelection | null, before: TileSnapshot): void {
  assertPixelEditable(layer)
  if (!['blur','sharpen','smudge'].includes(mode) || !Number.isFinite(strength) || strength < 1 || strength > 100) throw new Error('局部润色参数无效')
  const stroke = shapeSelection(points, 'brush', brush)
  const mask = selection ? combineSelections(stroke,selection,'intersect') : stroke
  if (!mask) return
  if (mode !== 'smudge') { filterLayer(layer,{filter:mode,amount:mode==='blur'?strength/100*12:strength},mask,before);return }
  // Carry a small pixel patch along the drag path, mixing it with destination color.
  let previous = points[0]
  for (const point of points.slice(1)) {
    const steps = Math.max(1,Math.ceil(Math.hypot(point.x-previous.x,point.y-previous.y)/Math.max(1,brush/4)))
    const start = previous
    for(let i=1;i<=steps;i++) {
      const center={x:start.x+(point.x-start.x)*i/steps,y:start.y+(point.y-start.y)*i/steps}
      const from=checkedSelectionBounds({x:previous.x-brush/2,y:previous.y-brush/2,width:brush,height:brush})
      const to=checkedSelectionBounds({x:center.x-brush/2,y:center.y-brush/2,width:brush,height:brush})
      const image=rasterizeRegion([rawLayer(layer)],from,to.width,to.height), target=rasterizeRegion([rawLayer(layer)],to,to.width,to.height)
      const src=image.getContext('2d')!.getImageData(0,0,image.width,image.height),dst=target.getContext('2d')!.getImageData(0,0,target.width,target.height)
      for(let p=0;p<src.data.length;p+=4){const amount=strength/100*src.data[p+3]/255;for(let c=0;c<3;c++)src.data[p+c]=dst.data[p+c]*(1-amount)+src.data[p+c]*amount;src.data[p+3]=dst.data[p+3]}
      image.getContext('2d')!.putImageData(src,0,0)
      const dab=maskStrokeSelection([center],brush,50,100,selection)
      if(dab) drawMaskedImage(layer,image,to,dab,before,true)
      previous=center
    }
  }
}

export function maskStrokeSelection(points: Point[], brush: number, hardness: number, opacity: number, selection: PixelSelection | null): PixelSelection | null {
  if (!Number.isFinite(hardness) || hardness < 0 || hardness > 100 || !Number.isFinite(opacity) || opacity < 0 || opacity > 100) throw new Error('笔刷参数无效')
  let stroke = shapeSelection(points, 'brush', brush)
  if (hardness < 100) stroke = modifySelection(stroke, 'feather', (100 - hardness) / 100 * brush / 6)
  const ctx = stroke.mask.getContext('2d')!, pixels = ctx.getImageData(0, 0, stroke.mask.width, stroke.mask.height)
  for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] *= opacity / 100
  ctx.putImageData(pixels, 0, 0)
  return selection ? combineSelections(stroke, selection, 'intersect') : stroke
}

export function paintBrushStroke(layer: CanvasLayer, points: Point[], erase: boolean, before: TileSnapshot, options: { color: string; brush: number; opacity: number; hardness: number }, selection: PixelSelection | null): void {
  assertPixelEditable(layer)
  if (!layer.visible) throw new Error('当前图层已隐藏')
  if (!/^#[0-9a-f]{6}$/i.test(options.color)) throw new Error('笔刷颜色无效')
  if (!Number.isFinite(options.brush) || options.brush < 1 || options.brush > 160) throw new Error('笔刷大小无效')
  const mask = maskStrokeSelection(points, options.brush, options.hardness, options.opacity, selection)
  if (!mask) return
  if (erase) clearMaskedSelection(layer, mask, before)
  else {
    const bounds = mask.bounds, image = canvasImage(bounds.width, bounds.height), ctx = image.getContext('2d')!
    ctx.fillStyle = options.color; ctx.fillRect(0,0,image.width,image.height)
    drawMaskedImage(layer,image,bounds,mask,before)
  }
}

export function textLayer(source: Omit<TextSource, 'matrix'> & { matrix?: TextSource['matrix'] }, existing?: CanvasLayer): CanvasLayer {
  if (existing?.locked) throw new Error('当前图层已锁定')
  const layer = createLayer(source.text.split('\n')[0].slice(0, 40) || '文字')
  applyDrawingCommand(layer, { action: 'draw_text', ...source }, null, new Map())
  const meta: TextSource = { ...source, matrix: source.matrix ?? [1,0,0,1,0,0] }
  const matrix = meta.matrix
  if (matrix.length !== 6 || !matrix.every(Number.isFinite)) throw new Error('文字变换无效')
  const bounds = layerPixelBounds(layer)
  if (bounds && matrix.some((v, i) => v !== [1,0,0,1,0,0][i])) {
    const points = [{x:bounds.x,y:bounds.y},{x:bounds.x+bounds.width,y:bounds.y},{x:bounds.x,y:bounds.y+bounds.height},{x:bounds.x+bounds.width,y:bounds.y+bounds.height}].map(p => ({x:matrix[0]*p.x+matrix[2]*p.y+matrix[4],y:matrix[1]*p.x+matrix[3]*p.y+matrix[5]}))
    const x = Math.min(...points.map(p=>p.x)), y = Math.min(...points.map(p=>p.y))
    const outputBounds = checkedSelectionBounds({ x, y, width: Math.max(...points.map(p=>p.x))-x, height: Math.max(...points.map(p=>p.y))-y })
    const image = canvasImage(outputBounds.width, outputBounds.height), ctx = image.getContext('2d')!
    ctx.translate(-outputBounds.x, -outputBounds.y); ctx.transform(...matrix); ctx.drawImage(rasterizeRegion([rawLayer(layer)], bounds, Math.ceil(bounds.width), Math.ceil(bounds.height)), bounds.x, bounds.y)
    layer.tiles = new Map(); drawImageOnLayer(layer, image, outputBounds)
  }
  if (existing) { layer.id = existing.id; layer.offset = { ...existing.offset }; layer.opacity = existing.opacity; layer.visible = existing.visible; layer.blendMode = existing.blendMode; layer.mask = existing.mask; layer.group = existing.group; layer.groupHidden = existing.groupHidden; layer.clipping = existing.clipping }
  layer.textSource = meta; return layer
}

export function healSegment(layer: CanvasLayer, frozen: CanvasLayer, from: Point, to: Point, delta: Point, brush: number, before: TileSnapshot, selection: PixelSelection | null): void {
  assertPixelEditable(layer)
  if (!Number.isFinite(brush) || brush < 1 || brush > 160) throw new Error('笔刷大小无效')
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, brush / 4)))
  for (let step = 0; step <= steps; step++) {
    const center = { x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps }
    const bounds = checkedSelectionBounds({ x: center.x - brush / 2, y: center.y - brush / 2, width: brush, height: brush })
    const source = rasterizeRegion([rawLayer(frozen)], { ...bounds, x: bounds.x + delta.x, y: bounds.y + delta.y }, bounds.width, bounds.height)
    const destination = rasterizeRegion([rawLayer(frozen)], bounds, bounds.width, bounds.height)
    const src = source.getContext('2d')!.getImageData(0,0,source.width,source.height), dst = destination.getContext('2d')!.getImageData(0,0,destination.width,destination.height)
    const average = (data: Uint8ClampedArray) => {
      const result = [0,0,0]; let count = 0
      for (let i=0;i<data.length;i+=4) { const alpha=data[i+3]/255; count+=alpha; for(let c=0;c<3;c++) result[c]+=data[i+c]*alpha }
      return result.map(v=>count?v/count:0)
    }
    const a = average(src.data), b = average(dst.data)
    for(let i=0;i<src.data.length;i+=4) { for(let c=0;c<3;c++) src.data[i+c]+=b[c]-a[c]; src.data[i+3]=dst.data[i+3] }
    source.getContext('2d')!.putImageData(src,0,0)
    const circle = shapeSelection([center], 'brush', brush), mask = selection ? combineSelections(circle, selection, 'intersect') : circle
    if (mask) drawMaskedImage(layer, source, bounds, mask, before, true)
  }
}

export function serializeLayer(layer: CanvasLayer) {
  return { id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, offset: layer.offset,
    blendMode: layer.blendMode, locked: layer.locked, alphaLocked: layer.alphaLocked, group: layer.group, groupHidden: layer.groupHidden, clipping: layer.clipping, textSource: layer.textSource,
    mask: layer.mask ? { bounds: layer.mask.bounds, outside: layer.mask.outside, enabled: layer.mask.enabled, data: layer.mask.canvas.toDataURL('image/png') } : undefined,
    tiles: [...layer.tiles].map(([key, canvas]) => [key, canvas.toDataURL('image/png')]) }
}
export async function deserializeLayers(entries: ReturnType<typeof serializeLayer>[]): Promise<CanvasLayer[]> {
  if (!Array.isArray(entries) || !entries.length || entries.length>100) throw new Error('项目图层无效')
  let count=0
  const ids=new Set<string>()
  const decode = async (data: string, width: number, height: number) => {
    if(typeof data!=='string' || !data.startsWith('data:image/png;base64,')) throw new Error('项目图像无效')
    const image=new Image(); image.src=data; await image.decode()
    if(image.naturalWidth!==width || image.naturalHeight!==height) throw new Error('项目图像尺寸无效')
    const canvas=canvasImage(width,height); canvas.getContext('2d')!.drawImage(image,0,0); return canvas
  }
  const layers:CanvasLayer[]=[]
  for(const entry of entries) {
    if(!entry || typeof entry.name!=='string' || !Array.isArray(entry.tiles) || entry.tiles.length>1024 || !Number.isFinite(entry.offset?.x) || !Number.isFinite(entry.offset?.y) || Math.abs(entry.offset.x)>1e9 || Math.abs(entry.offset.y)>1e9 || !Number.isFinite(entry.opacity) || entry.opacity<0 || entry.opacity>1) throw new Error('项目图层属性无效')
    const layer=createLayer(entry.name.slice(0,80)); layer.id=entry.id||layer.id
    if(ids.has(layer.id)) throw new Error('项目图层 ID 重复'); ids.add(layer.id)
    layer.visible=entry.visible!==false; layer.opacity=entry.opacity; layer.offset={...entry.offset}
    if(entry.blendMode && !BLEND_MODES.includes(entry.blendMode)) throw new Error('图层混合模式无效')
    layer.blendMode=entry.blendMode; layer.locked=entry.locked===true; layer.alphaLocked=entry.alphaLocked===true; layer.clipping=entry.clipping===true
    if(entry.group!==undefined && (typeof entry.group!=='string' || entry.group.length>80)) throw new Error('图层分组无效')
    layer.group=entry.group; layer.groupHidden=entry.groupHidden===true
    if(entry.textSource) {
      const meta=entry.textSource
      if(!Array.isArray(meta.matrix) || meta.matrix.length!==6 || !meta.matrix.every(Number.isFinite)) throw new Error('文字图层变换无效')
      // Validate editable source independently of its saved raster tiles.
      textLayer(meta); layer.textSource={...meta,matrix:[...meta.matrix]}
    }
    if(entry.mask) {
      const bounds={...entry.mask.bounds}
      if(![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite) || bounds.width<1 || bounds.height<1 || bounds.width>4096 || bounds.height>4096 || !Number.isInteger(bounds.width) || !Number.isInteger(bounds.height) || Math.abs(bounds.x)>1e9 || Math.abs(bounds.y)>1e9) throw new Error('图层蒙版范围无效')
      if(![0,1].includes(entry.mask.outside)) throw new Error('图层蒙版属性无效')
      layer.mask={bounds,outside:entry.mask.outside,enabled:entry.mask.enabled!==false,canvas:await decode(entry.mask.data,bounds.width,bounds.height)}
    }
    for(const [key,data] of entry.tiles) {
      if(typeof key!=='string' || !/^-?\d+,-?\d+$/.test(key) || key.split(',').some(v=>Math.abs(Number(v))>2_000_000) || ++count>4096) throw new Error('项目图块无效')
      if(layer.tiles.has(key)) throw new Error('项目图块重复')
      layer.tiles.set(key,await decode(data,TILE_SIZE,TILE_SIZE))
    }
    layers.push(layer)
  }
  return layers
}

export function exportedImage(layers: CanvasLayer[], doc: DocumentSettings, selection: PixelSelection | null, format: 'png'|'jpeg'|'webp', quality = .92): { base64: string; width: number; height: number; mime: string } {
  if (!['png','jpeg','webp'].includes(format) || !Number.isFinite(quality) || quality < .1 || quality > 1) throw new Error('导出参数无效')
  const bounds = checkedSelectionBounds(selection?.bounds ?? doc.bounds ?? contentPixelBounds(layers) ?? (() => { throw new Error('画布为空') })())
  const image = rasterizeRegion(layers, bounds, bounds.width, bounds.height), ctx = image.getContext('2d')!
  ctx.setTransform(1,0,0,1,0,0)
  if (selection) { ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(selectionMask(selection, bounds),0,0) }
  const background = format === 'jpeg' && doc.background === 'transparent' ? '#ffffff' : doc.background
  if (background !== 'transparent') { ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = background; ctx.fillRect(0,0,image.width,image.height) }
  const mime = `image/${format}`, url = image.toDataURL(mime,quality)
  if (!url.startsWith(`data:${mime};`)) throw new Error('当前环境不支持此图片格式')
  return { base64: url.split(',')[1], width: image.width, height: image.height, mime }
}

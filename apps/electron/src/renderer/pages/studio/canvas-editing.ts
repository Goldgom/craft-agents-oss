import { rawLayer, layerMaskImage, MAX_RASTER_SIDE, createLayer, drawImageOnLayer, layerPixelBounds, rasterizeRegion, type CanvasLayer, type Point, type Rect, type TileSnapshot } from './canvas-engine'
import { checkedSelectionBounds, combineSelections, drawMaskedImage, selectionMask, shapeSelection, type PixelSelection } from './canvas-retouch'

export const editingActions = ['crop_layer', 'transform_layer', 'pixelate', 'exposure_brush'] as const
export type ExposureMode = 'dodge' | 'burn'

export function resizeDimensions(width: number, height: number, axis: 'width' | 'height', value: number, locked: boolean): { width: number; height: number } {
  if (![width, height, value].every(Number.isFinite) || width < 1 || height < 1 || width > MAX_RASTER_SIDE || height > MAX_RASTER_SIDE) throw new Error('变换尺寸无效')
  if (!locked) return { width: axis === 'width' ? Math.max(1, Math.min(MAX_RASTER_SIDE, Math.round(value))) : width, height: axis === 'height' ? Math.max(1, Math.min(MAX_RASTER_SIDE, Math.round(value))) : height }
  const scale = Math.max(1 / Math.min(width, height), Math.min(MAX_RASTER_SIDE / Math.max(width, height), value / (axis === 'width' ? width : height)))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

function finite(input: Record<string, unknown>, key: string, fallback?: number): number {
  const value = input[key] ?? fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} 必须为有效数字`)
  return value
}
function limited(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = finite(input, key, fallback)
  if (value < min || value > max) throw new Error(`${key} 必须在 ${min}–${max} 内`)
  return value
}
function visibleLayer(layer: CanvasLayer): void {
  if (layer.locked) throw new Error('当前图层已锁定')
  if (!layer.visible) throw new Error('请先显示当前图层')
}
function replacement(layer: CanvasLayer, image: HTMLCanvasElement, bounds: Rect): CanvasLayer {
  const next = { ...createLayer(layer.name), ...layer, offset: { ...layer.offset }, tiles: new Map<string, HTMLCanvasElement>() }
  drawImageOnLayer(next, image, bounds)
  return next
}

/** Crops only the active layer, retaining world position, alpha and the actual mask. */
export function cropLayer(layer: CanvasLayer, selection: PixelSelection | null, input: Record<string, unknown> = {}): CanvasLayer {
  visibleLayer(layer)
  const explicit = ['x', 'y', 'width', 'height'].some(key => input[key] !== undefined)
  const bounds = checkedSelectionBounds(explicit
    ? { x: finite(input, 'x'), y: finite(input, 'y'), width: finite(input, 'width'), height: finite(input, 'height') }
    : selection?.bounds ?? (() => { throw new Error('裁剪需要选区或明确的矩形范围') })())
  const image = rasterizeRegion([rawLayer(layer)], bounds, bounds.width, bounds.height)
  if (selection) {
    const ctx = image.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(selectionMask(selection, bounds), 0, 0)
  }
  return { ...replacement(layer, image, bounds), textSource: undefined }
}

export function transformedBounds(bounds: Rect, width: number, height: number, angle: number, skewX = 0, skewY = 0): Rect {
  checkedSelectionBounds(bounds)
  if (![width, height, angle, skewX, skewY].every(Number.isFinite) || width < 1 || height < 1 || width > MAX_RASTER_SIDE || height > MAX_RASTER_SIDE || Math.abs(angle) > 360 || Math.abs(skewX)>75 || Math.abs(skewY)>75) throw new Error('变换尺寸或角度无效')
  const radians = angle * Math.PI / 180
  const tx=Math.tan(skewX*Math.PI/180),ty=Math.tan(skewY*Math.PI/180),cos=Math.cos(radians),sin=Math.sin(radians)
  const w = Math.ceil(Math.abs(width*(cos-sin*ty))+Math.abs(height*(cos*tx-sin))-1e-9)
  const h = Math.ceil(Math.abs(width*(sin+cos*ty))+Math.abs(height*(sin*tx+cos))-1e-9)
  // Preserve the exact center even for odd output dimensions; reject rotated allocations before drawing.
  const result = { x: bounds.x + (bounds.width - w) / 2, y: bounds.y + (bounds.height - h) / 2, width: w, height: h }
  if (w > MAX_RASTER_SIDE || h > MAX_RASTER_SIDE) throw new Error('旋转后的图像单边最多 4096 像素')
  return result
}

/** All flips, right-angle rotations, resizes and arbitrary rotations share this implementation. */
export function transformLayerContent(layer: CanvasLayer, input: Record<string, unknown>): { layer: CanvasLayer; bounds: Rect } {
  visibleLayer(layer)
  const sourceBounds = layerPixelBounds(layer)
  if (!sourceBounds) throw new Error('当前图层为空')
  const scope = checkedSelectionBounds(sourceBounds)
  const kind = input.transform ?? 'resize-rotate'
  if (!['flip-x', 'flip-y', 'rotate', 'resize-rotate'].includes(String(kind))) throw new Error('不支持的变换类型')
  const width = kind === 'resize-rotate' ? limited(input, 'targetWidth', scope.width, 1, MAX_RASTER_SIDE) : scope.width
  const height = kind === 'resize-rotate' ? limited(input, 'targetHeight', scope.height, 1, MAX_RASTER_SIDE) : scope.height
  const angle = kind === 'rotate' ? 90 : kind === 'resize-rotate' ? limited(input, 'angle', 0, -360, 360) : 0
  const skewX=limited(input,'skewX',0,-75,75),skewY=limited(input,'skewY',0,-75,75)
  const tx=Math.tan(skewX*Math.PI/180),ty=Math.tan(skewY*Math.PI/180)
  if(Math.abs(1-tx*ty)<.01) throw new Error('斜切变换不可退化为直线')
  const bounds = transformedBounds(scope, width, height, angle,skewX,skewY)
  const source = rasterizeRegion([rawLayer(layer)], scope, scope.width, scope.height)
  const image = document.createElement('canvas'); image.width = bounds.width; image.height = bounds.height
  const ctx = image.getContext('2d')!
  ctx.imageSmoothingEnabled = input.smoothing !== false
  if (input.smoothing !== undefined && typeof input.smoothing !== 'boolean') throw new Error('smoothing 必须为布尔值')
  ctx.translate(image.width / 2, image.height / 2); ctx.rotate(angle * Math.PI / 180);ctx.transform(1,ty,tx,1,0,0)
  ctx.scale(kind === 'flip-x' ? -1 : 1, kind === 'flip-y' ? -1 : 1)
  ctx.drawImage(source, -width / 2, -height / 2, width, height)
  const next = replacement(layer, image, bounds)
  if (layer.mask) {
    const mask = layerMaskImage({ ...layer, mask: { ...layer.mask, enabled: true } }, scope, scope.width, scope.height)
    const output = document.createElement('canvas'); output.width = image.width; output.height = image.height
    const mctx = output.getContext('2d')!; mctx.translate(output.width/2,output.height/2); mctx.rotate(angle*Math.PI/180);mctx.transform(1,ty,tx,1,0,0); mctx.scale(kind==='flip-x'?-1:1,kind==='flip-y'?-1:1); mctx.drawImage(mask,-width/2,-height/2,width,height)
    next.mask = { bounds: { ...bounds, x: bounds.x-layer.offset.x, y: bounds.y-layer.offset.y }, canvas: output, outside: 0, enabled: layer.mask.enabled }
  }
  if (layer.textSource) {
    const radians=angle*Math.PI/180, sx=width/scope.width*(kind==='flip-x'?-1:1), sy=height/scope.height*(kind==='flip-y'?-1:1)
    const a=(Math.cos(radians)-Math.sin(radians)*ty)*sx,b=(Math.sin(radians)+Math.cos(radians)*ty)*sx,c=(Math.cos(radians)*tx-Math.sin(radians))*sy,d=(Math.sin(radians)*tx+Math.cos(radians))*sy
    const cx=scope.x+scope.width/2-layer.offset.x,cy=scope.y+scope.height/2-layer.offset.y,e=cx-a*cx-c*cy,f=cy-b*cx-d*cy
    const m=layer.textSource.matrix
    next.textSource={...layer.textSource,matrix:[a*m[0]+c*m[1],b*m[0]+d*m[1],a*m[2]+c*m[3],b*m[2]+d*m[3],a*m[4]+c*m[5]+e,b*m[4]+d*m[5]+f]}
  }
  return { layer: next, bounds }
}

/** Average premultiplied colors per block, retaining each original pixel's alpha. */
export function pixelatePixels(image: ImageData, blockSize: number): void {
  if (!Number.isInteger(blockSize) || blockSize < 2 || blockSize > 128) throw new Error('马赛克像素块需要在 2–128 内')
  const { width, height, data } = image
  for (let by = 0; by < height; by += blockSize) for (let bx = 0; bx < width; bx += blockSize) {
    const right = Math.min(width, bx + blockSize), bottom = Math.min(height, by + blockSize)
    let r = 0, g = 0, b = 0, alpha = 0
    for (let y = by; y < bottom; y++) for (let x = bx; x < right; x++) {
      const i = (y * width + x) * 4, a = data[i + 3]
      r += data[i] * a; g += data[i + 1] * a; b += data[i + 2] * a; alpha += a
    }
    if (!alpha) continue
    for (let y = by; y < bottom; y++) for (let x = bx; x < right; x++) {
      const i = (y * width + x) * 4
      if (data[i + 3]) { data[i] = r / alpha; data[i + 1] = g / alpha; data[i + 2] = b / alpha }
    }
  }
}

export function exposurePixels(data: Uint8ClampedArray, mode: ExposureMode, strength: number): void {
  if (!['dodge', 'burn'].includes(mode) || !Number.isFinite(strength) || strength < 1 || strength > 100) throw new Error('明暗模式或强度无效')
  const amount = strength / 100
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]) {
    for (let c = 0; c < 3; c++) data[i + c] = mode === 'dodge' ? data[i + c] + (255 - data[i + c]) * amount : data[i + c] * (1 - amount)
  }
}

/** A stroke reads a frozen source so overlapping segments do not repeatedly intensify an edit. */
export function applyEditingPixels(layer: CanvasLayer, source: CanvasLayer, input: Record<string, unknown>, selection: PixelSelection | null, before: TileSnapshot): Rect | null {
  visibleLayer(layer)
  const action = input.action
  if (action !== 'pixelate' && action !== 'exposure_brush') throw new Error('不支持的像素编辑')
  const brush = limited(input, 'brush', 24, 1, 160)
  const blockSize = limited(input, 'blockSize', 12, 2, 128)
  if (!Number.isInteger(blockSize)) throw new Error('blockSize 必须为整数')
  const strength = limited(input, 'strength', 20, 1, 100)
  const mode = (input.exposureMode ?? 'dodge') as ExposureMode
  if (!['dodge', 'burn'].includes(mode)) throw new Error('不支持的明暗模式')
  let mask: PixelSelection | null = selection
  let bounds: Rect
  if (input.points !== undefined || action === 'exposure_brush') {
    const points = input.points ?? [{ x: finite(input, 'x'), y: finite(input, 'y') }, { x: finite(input, 'toX', finite(input, 'x')), y: finite(input, 'toY', finite(input, 'y')) }]
    if (!Array.isArray(points) || !points.length || points.length > 2000) throw new Error('笔画需要 1–2000 个坐标点')
    const stroke = shapeSelection(points as Point[], 'brush', brush)
    mask = selection ? combineSelections(stroke, selection, 'intersect') : stroke
    if (!mask) return null
    bounds = checkedSelectionBounds(mask.bounds)
  } else {
    const explicit = ['x', 'y', 'width', 'height'].some(key => input[key] !== undefined)
    const scope = explicit ? { x: finite(input, 'x'), y: finite(input, 'y'), width: finite(input, 'width'), height: finite(input, 'height') } : selection?.bounds ?? layerPixelBounds(layer)
    if (!scope) throw new Error('当前图层为空')
    bounds = checkedSelectionBounds(scope)
  }
  // Align to world coordinates, so brush motion and tile boundaries do not shift mosaic blocks.
  // bounds is already checked; alignment adds at most 127 pixels per edge.
  const sampleBounds = action === 'pixelate' ? {
    x: Math.floor(bounds.x / blockSize) * blockSize, y: Math.floor(bounds.y / blockSize) * blockSize,
    width: Math.ceil((bounds.x + bounds.width) / blockSize) * blockSize - Math.floor(bounds.x / blockSize) * blockSize,
    height: Math.ceil((bounds.y + bounds.height) / blockSize) * blockSize - Math.floor(bounds.y / blockSize) * blockSize,
  } : bounds
  const image = rasterizeRegion([rawLayer(source)], sampleBounds, sampleBounds.width, sampleBounds.height)
  const ctx = image.getContext('2d')!, pixels = ctx.getImageData(0, 0, image.width, image.height)
  if (action === 'pixelate') pixelatePixels(pixels, blockSize)
  else exposurePixels(pixels.data, mode, strength)
  ctx.putImageData(pixels, 0, 0)
  const result = document.createElement('canvas'); result.width = bounds.width; result.height = bounds.height
  result.getContext('2d')!.drawImage(image, bounds.x - sampleBounds.x, bounds.y - sampleBounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height)
  drawMaskedImage(layer, result, bounds, mask, before, true)
  return bounds
}

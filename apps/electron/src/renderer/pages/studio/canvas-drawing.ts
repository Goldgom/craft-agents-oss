import { rawLayer, layerPixelBounds, normalizeRect, rasterizeRegion, type CanvasLayer, type Point, type Rect, type TileSnapshot } from './canvas-engine'
import { checkedSelectionBounds, contiguousColorMask, drawMaskedImage, pathBounds, selectionMask, type PixelSelection } from './canvas-retouch'

export const drawingActions = ['fill_region', 'draw_text', 'draw_shape', 'draw_gradient'] as const
export type DrawingAction = typeof drawingActions[number]
export type DrawingShape = 'rectangle' | 'ellipse' | 'line' | 'arrow'

/** Both pointer tools and canvas_tool execute here, using the same validation and masks. */
export function applyDrawingCommand(layer: CanvasLayer, input: Record<string, unknown>, selection: PixelSelection | null, before: TileSnapshot): Rect {
  if (!layer.visible) throw new Error('请先显示当前图层')
  const number = (key: string, fallback?: number) => {
    const value = input[key] ?? fallback
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} 必须为有效数字`)
    return value
  }
  const limited = (key: string, fallback: number, min: number, max: number) => {
    const value = number(key, fallback)
    if (value < min || value > max) throw new Error(`${key} 必须在 ${min}–${max} 内`)
    return value
  }
  const color = (key: string, fallback: string) => {
    const value = input[key] ?? fallback
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${key} 需要 #RRGGBB 颜色`)
    return value
  }
  const action = input.action
  if (!drawingActions.includes(action as DrawingAction)) throw new Error('未知绘制操作')
  const start: Point = { x: number('x'), y: number('y') }
  checkedSelectionBounds({ ...start, width: 1, height: 1 })
  const primary = color('color', '#000000')
  let bounds: Rect, render: (ctx: CanvasRenderingContext2D) => void
  let effectiveSelection = selection
  if (action === 'fill_region') {
    const scope = input.width !== undefined || input.height !== undefined
      ? { x: number('boundsX', start.x), y: number('boundsY', start.y), width: number('width'), height: number('height') }
      : selection?.bounds ?? layerPixelBounds(layer)
    if (!scope) throw new Error('空图层需要选区或明确的填充范围')
    bounds = checkedSelectionBounds(scope)
    if (start.x < bounds.x || start.y < bounds.y || start.x >= bounds.x + bounds.width || start.y >= bounds.y + bounds.height) throw new Error('填充起点必须位于填充范围内')
    const source = rasterizeRegion([rawLayer(layer)], bounds, bounds.width, bounds.height)
    const pixels = source.getContext('2d')!.getImageData(0, 0, source.width, source.height)
    const allowed = selectionMask(selection, bounds).getContext('2d')!.getImageData(0, 0, source.width, source.height)
    const alpha = contiguousColorMask(pixels, { x: start.x - bounds.x, y: start.y - bounds.y }, limited('tolerance', 32, 0, 100), allowed.data)
    // Connectivity is constrained by the selection; apply fractional edge coverage only once.
    for (let i = 0; i < alpha.length; i++) { pixels.data.fill(255, i * 4, i * 4 + 3); pixels.data[i * 4 + 3] = alpha[i] ? allowed.data[i * 4 + 3] : 0 }
    source.getContext('2d')!.putImageData(pixels, 0, 0)
    effectiveSelection = { bounds, mask: source, kind: 'wand' }
    render = ctx => { ctx.fillStyle = primary; ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height) }
  } else if (action === 'draw_text') {
    const text = input.text
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('文字需要 1–2000 个字符')
    const fontSize = limited('fontSize', 32, 8, 512)
    const family = input.fontFamily ?? 'sans-serif'
    if (typeof family !== 'string' || !/^[\p{L}\p{N} _-]{1,80}$/u.test(family)) throw new Error('不支持的字体')
    if (input.bold !== undefined && typeof input.bold !== 'boolean') throw new Error('bold 必须为布尔值')
    const font = `${input.bold === true ? 'bold ' : ''}${fontSize}px ${family.includes(' ') ? JSON.stringify(family) : family}`
    const measure = document.createElement('canvas').getContext('2d')!; measure.font = font
    const lines = text.replace(/\r\n?/g, '\n').split('\n'), lineHeight = fontSize * 1.3
    // Include glyph overhang (e.g. italic system fallback) and vertical font metrics.
    const metrics = lines.map(line => measure.measureText(line))
    const left = Math.max(0, ...metrics.map(m => m.actualBoundingBoxLeft))
    const right = Math.max(1, ...metrics.map(m => Math.max(m.width, m.actualBoundingBoxRight)))
    bounds = checkedSelectionBounds({ x: start.x - left - 2, y: start.y - fontSize, width: left + right + 4, height: lines.length * lineHeight + fontSize * 2 })
    render = ctx => {
      ctx.font = font; ctx.textBaseline = 'top'; ctx.fillStyle = primary
      lines.forEach((line, index) => ctx.fillText(line, start.x, start.y + index * lineHeight))
    }
  } else {
    const end: Point = { x: number('toX'), y: number('toY') }
    if (start.x === end.x && start.y === end.y) throw new Error('拖动范围不能为空')
    if (action === 'draw_gradient') {
      const secondary = color('secondaryColor', '#ffffff')
      const kind = input.gradientKind ?? 'linear'
      if (!['linear', 'radial'].includes(String(kind))) throw new Error('不支持的渐变类型')
      bounds = checkedSelectionBounds(selection?.bounds ?? normalizeRect(start, end))
      render = ctx => {
        const gradient = kind === 'radial' ? ctx.createRadialGradient(start.x, start.y, 0, start.x, start.y, Math.hypot(end.x - start.x, end.y - start.y)) : ctx.createLinearGradient(start.x, start.y, end.x, end.y)
        gradient.addColorStop(0, primary); gradient.addColorStop(1, secondary)
        ctx.fillStyle = gradient; ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height)
      }
    } else {
      const shape = input.shape ?? 'rectangle'
      if (!['rectangle', 'ellipse', 'line', 'arrow'].includes(String(shape))) throw new Error('不支持的形状')
      if (input.filled !== undefined && typeof input.filled !== 'boolean') throw new Error('filled 必须为布尔值')
      const width = limited('brush', 4, 1, 160), head = Math.max(10, width * 3)
      const rect = normalizeRect(start, end)
      if ((shape === 'rectangle' || shape === 'ellipse') && (!rect.width || !rect.height)) throw new Error('形状需要有效宽高')
      bounds = pathBounds([start, end], shape === 'arrow' ? head + width : width / 2 + 2)
      render = ctx => {
        ctx.strokeStyle = ctx.fillStyle = primary; ctx.lineWidth = width; ctx.lineCap = ctx.lineJoin = 'round'; ctx.beginPath()
        if (shape === 'rectangle') ctx.rect(rect.x, rect.y, rect.width, rect.height)
        else if (shape === 'ellipse') ctx.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, rect.height / 2, 0, 0, Math.PI * 2)
        else { ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y) }
        if (input.filled === true && (shape === 'rectangle' || shape === 'ellipse')) ctx.fill()
        else ctx.stroke()
        if (shape === 'arrow') {
          const angle = Math.atan2(end.y - start.y, end.x - start.x)
          ctx.beginPath(); ctx.moveTo(end.x - head * Math.cos(angle - Math.PI / 6), end.y - head * Math.sin(angle - Math.PI / 6))
          ctx.lineTo(end.x, end.y); ctx.lineTo(end.x - head * Math.cos(angle + Math.PI / 6), end.y - head * Math.sin(angle + Math.PI / 6)); ctx.stroke()
        }
      }
    }
  }
  const image = document.createElement('canvas'); image.width = bounds.width; image.height = bounds.height
  const ctx = image.getContext('2d')!; ctx.translate(-bounds.x, -bounds.y); render(ctx)
  drawMaskedImage(layer, image, bounds, effectiveSelection, before)
  return bounds
}

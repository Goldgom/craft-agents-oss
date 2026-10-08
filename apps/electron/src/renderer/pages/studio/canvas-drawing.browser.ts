import { captureTile, createLayer, drawImageOnLayer, rasterizeRegion, restoreTiles, type CanvasLayer, type TileSnapshot } from './canvas-engine'
import { applyDrawingCommand } from './canvas-drawing'
import { combineSelections, rectangularSelection, shapeSelection } from './canvas-retouch'

export function runDrawingChecks(): string[] {
  const checks: string[] = []
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  const pixel = (layer: CanvasLayer, x: number, y: number) => [...rasterizeRegion([{ ...layer, visible: true, opacity: 1 }], { x, y, width: 1, height: 1 }, 1, 1).getContext('2d')!.getImageData(0, 0, 1, 1).data]
  const draw = (layer: CanvasLayer, input: Record<string, unknown>, mask: Parameters<typeof applyDrawingCommand>[2] = null) => {
    const before: TileSnapshot = new Map()
    const bounds = applyDrawingCommand(layer, input, mask, before)
    const after: TileSnapshot = new Map([...before.keys()].map(key => [key, captureTile(layer, key)]))
    return { bounds, before, after }
  }
  const solid = (layer: CanvasLayer, width = 32, height = 32) => {
    const image = document.createElement('canvas'); image.width = width; image.height = height
    const ctx = image.getContext('2d')!; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height)
    drawImageOnLayer(layer, image, { x: 0, y: 0, width, height })
  }
  const fill = createLayer(); solid(fill)
  draw(fill, { action: 'draw_shape', shape: 'line', x: 16, y: 0, toX: 16, toY: 32, brush: 2, color: '#000000' })
  const filled = draw(fill, { action: 'fill_region', x: 2, y: 2, color: '#ff0000', tolerance: 0 })
  assert(pixel(fill, 2, 2).join() === '255,0,0,255', 'Fill did not change connected pixels')
  assert(pixel(fill, 24, 2).join() === '255,255,255,255', 'Fill crossed a color boundary')
  restoreTiles(fill, filled.before); assert(pixel(fill, 2, 2).join() === '255,255,255,255', 'Fill undo failed')
  restoreTiles(fill, filled.after); assert(pixel(fill, 2, 2).join() === '255,0,0,255', 'Fill redo failed')
  checks.push('paint bucket connectivity, color boundaries, undo and redo')

  const empty = createLayer(); empty.offset = { x: 5, y: -4 }
  draw(empty, { action: 'fill_region', x: -10, y: -10, boundsX: -16, boundsY: -16, width: 24, height: 24, color: '#00ff00' })
  assert(pixel(empty, -10, -10).join() === '0,255,0,255' && pixel(empty, 10, 10)[3] === 0, 'Empty fill escaped its explicit scope')
  checks.push('transparent paint bucket at negative coordinates with a layer offset')

  const disconnected = combineSelections(rectangularSelection({ x: 0, y: 0, width: 32, height: 32 }), rectangularSelection({ x: 14, y: 0, width: 4, height: 32 }), 'subtract')!
  const constrained = createLayer(); solid(constrained)
  draw(constrained, { action: 'fill_region', x: 2, y: 2, color: '#0000ff' }, disconnected)
  assert(pixel(constrained, 2, 2)[2] === 255 && pixel(constrained, 2, 2)[0] === 0, 'Selected fill did not apply')
  assert(pixel(constrained, 16, 2).join() === '255,255,255,255' && pixel(constrained, 24, 2).join() === '255,255,255,255', 'Fill crossed an unselected barrier')
  const blocked = draw(constrained, { action: 'fill_region', x: 16, y: 2, color: '#ff0000' }, disconnected)
  assert(blocked.before.size === 0, 'Unselected fill seed changed pixels')
  checks.push('paint bucket treats selection holes as connectivity barriers')

  const donut = combineSelections(rectangularSelection({ x: 0, y: 0, width: 32, height: 32 }), shapeSelection([{ x: 16, y: 16 }], 'brush', 8), 'subtract')!
  for (const shape of ['rectangle', 'ellipse', 'line', 'arrow']) {
    const layer = createLayer(); layer.offset = { x: 7, y: -3 }
    const action = draw(layer, { action: 'draw_shape', shape, x: -12, y: -12, toX: 28, toY: 28, filled: true, brush: 4, color: '#ff0000' }, donut)
    assert(action.before.size > 0, `${shape} created no pixels`)
    assert(pixel(layer, 16, 16)[3] === 0 && pixel(layer, -8, -8)[3] === 0, `${shape} ignored selection`)
    restoreTiles(layer, action.before); assert(layer.tiles.size === 0, `${shape} undo left tiles`)
    restoreTiles(layer, action.after); assert(layer.tiles.size > 0, `${shape} redo lost pixels`)
    checks.push(`${shape} drawing respects mask holes, layer offsets, undo and redo`)
  }
  const outline = createLayer()
  draw(outline, { action: 'draw_shape', shape: 'rectangle', x: 500, y: 0, toX: 532, toY: 32, brush: 2, color: '#00ff00' })
  assert(pixel(outline, 516, 16)[3] === 0 && pixel(outline, 512, 0)[1] === 255, 'Rectangle outline or tile seam failed')
  checks.push('shape outline preserves its interior across a tile seam')

  const rectangle = createLayer(), ellipse = createLayer(), line = createLayer(), arrow = createLayer()
  for (const [layer, shape] of [[rectangle, 'rectangle'], [ellipse, 'ellipse']] as const) {
    draw(layer, { action: 'draw_shape', shape, x: 0, y: 0, toX: 32, toY: 32, filled: true, color: '#ff0000' })
  }
  assert(pixel(rectangle, 2, 2)[3] === 255 && pixel(ellipse, 2, 2)[3] === 0 && pixel(ellipse, 16, 16)[3] === 255, 'Ellipse and rectangle geometry are not distinct')
  for (const [layer, shape] of [[line, 'line'], [arrow, 'arrow']] as const) {
    draw(layer, { action: 'draw_shape', shape, x: 0, y: 0, toX: 40, toY: 0, brush: 2, color: '#ff0000' })
  }
  assert(pixel(line, 32, 4)[3] === 0 && pixel(arrow, 32, 4)[3] > 0, 'Arrow is missing its arrowhead')
  checks.push('rectangle, ellipse, line and arrow produce distinct geometry')

  for (const gradientKind of ['linear', 'radial']) {
    const gradient = createLayer()
    const action = draw(gradient, { action: 'draw_gradient', gradientKind, x: 0, y: 0, toX: 32, toY: gradientKind === 'linear' ? 0 : 32, color: '#ff0000', secondaryColor: '#0000ff' }, donut)
    assert(pixel(gradient, 2, 2)[0] > pixel(gradient, 28, 28)[0], `${gradientKind} gradient direction failed`)
    assert(pixel(gradient, 16, 16)[3] === 0 && pixel(gradient, 40, 40)[3] === 0, `${gradientKind} gradient ignored mask`)
    const horizontal = pixel(gradient, 24, 2)[0], vertical = pixel(gradient, 2, 24)[0]
    assert(gradientKind === 'radial' ? Math.abs(horizontal - vertical) <= 1 : Math.abs(horizontal - vertical) > 100, `${gradientKind} gradient uses the wrong geometry`)
    restoreTiles(gradient, action.before); assert(gradient.tiles.size === 0, `${gradientKind} undo failed`)
    restoreTiles(gradient, action.after); assert(pixel(gradient, 2, 2)[3] === 255, `${gradientKind} redo failed`)
    checks.push(`${gradientKind} gradient colors, selection holes, undo and redo`)
  }
  const drag = createLayer()
  draw(drag, { action: 'draw_gradient', x: 20, y: 20, toX: -20, toY: -20, color: '#ff0000', secondaryColor: '#0000ff' })
  assert(pixel(drag, 15, 15)[0] > pixel(drag, -15, -15)[0] && pixel(drag, 24, 24)[3] === 0, 'Reverse gradient drag failed')
  checks.push('gradient drag rectangle bounds and reversed direction')

  const text = createLayer(); text.offset = { x: 6, y: -4 }
  const textResult = draw(text, { action: 'draw_text', x: -8, y: -8, text: 'Hello\n绘图', fontSize: 24, bold: true, fontFamily: 'sans-serif', color: '#00ff00' })
  const image = rasterizeRegion([text], textResult.bounds, textResult.bounds.width, textResult.bounds.height)
  const pixels = image.getContext('2d')!.getImageData(0, 0, image.width, image.height).data
  let first = 0, second = 0
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) {
    const y = Math.floor(i / 4 / image.width) + textResult.bounds.y
    if (y < 23) first++; else second++
  }
  assert(first > 10 && second > 10, 'Multiline / Chinese text was not rasterized')
  restoreTiles(text, textResult.before); assert(text.tiles.size === 0, 'Text undo failed')
  restoreTiles(text, textResult.after); assert(pixel(text, 100, 100)[3] === 0, 'Text escaped bounds')
  const maskedText = createLayer()
  draw(maskedText, { action: 'draw_text', x: 0, y: 0, text: 'MMMM', fontSize: 32, color: '#00ff00' }, donut)
  assert(pixel(maskedText, 16, 16)[3] === 0 && pixel(maskedText, 40, 10)[3] === 0, 'Text ignored selection holes or bounds')
  assert(maskedText.tiles.size > 0, 'Masked text drew nothing')
  checks.push('multiline Chinese text, masking, negative coordinates, layer offsets, undo and redo')

  const invalid = createLayer()
  for (const input of [
    { action: 'fill_region', x: 0, y: 0 },
    { action: 'fill_region', x: 0, y: 0, width: 4097, height: 10 },
    { action: 'draw_text', x: 0, y: 0, text: ' ', fontSize: 24 },
    { action: 'draw_text', x: 0, y: 0, text: 'A', fontSize: 513 },
    { action: 'draw_shape', x: 0, y: 0, toX: 10000, toY: 20 },
    { action: 'draw_shape', x: 0, y: 0, toX: 20, toY: 20, shape: 'invalid' },
    { action: 'draw_gradient', x: 0, y: 0, toX: 0, toY: 0 },
    { action: 'draw_gradient', x: 0, y: 0, toX: 20, toY: 20, secondaryColor: 'invalid' },
    { action: 'draw_text', x: Infinity, y: 0, text: 'A' },
  ]) {
    let rejected = false
    try { draw(invalid, input) } catch { rejected = true }
    assert(rejected && invalid.tiles.size === 0, `Invalid input mutated layer: ${JSON.stringify(input)}`)
  }
  invalid.visible = false
  let hiddenRejected = false
  try { draw(invalid, { action: 'draw_text', x: 0, y: 0, text: 'A' }) } catch { hiddenRejected = true }
  assert(hiddenRejected, 'Hidden layer was changed')
  checks.push('all drawing tools reject invalid sizes, coordinates, parameters and hidden layers before mutation')
  return checks
}

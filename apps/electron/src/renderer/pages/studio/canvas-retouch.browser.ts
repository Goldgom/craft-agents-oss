import { captureTile, createLayer, drawImageOnLayer, rasterizeRegion, restoreTiles, type CanvasLayer, type Rect, type TileSnapshot } from './canvas-engine'
import { applyAdjustments, defaultAdjustments } from './studio-adjustments'
import { clearMaskedSelection, cloneSegment, combineSelections, drawMaskedImage, invertSelection, paintMaskedSegment, rectangularSelection, sampleColor, selectionMask, shapeSelection, snapshotLayer, wandSelection } from './canvas-retouch'

/** Run in real Chromium: Canvas compositing, tile seams and alpha cannot be verified with DOM stubs. */
export function runRetouchChecks(): string[] {
  const checks: string[] = []
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  const solid = (color: string, width = 64, height = 64) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = color; ctx.fillRect(0, 0, width, height); return canvas
  }
  const pixel = (layer: CanvasLayer, x: number, y: number) => [...rasterizeRegion([{ ...layer, visible: true, opacity: 1 }], { x, y, width: 1, height: 1 }, 1, 1).getContext('2d')!.getImageData(0, 0, 1, 1).data]
  const alpha = (mask: HTMLCanvasElement, x: number, y: number) => mask.getContext('2d')!.getImageData(x, y, 1, 1).data[3]

  const bounds: Rect = { x: -20, y: -20, width: 64, height: 64 }, layer = createLayer('Fixture')
  layer.offset = { x: 5, y: -9 }; drawImageOnLayer(layer, solid('#ff0000'), bounds)
  const triangle = shapeSelection([{ x: -10, y: -10 }, { x: 30, y: -10 }, { x: -10, y: 30 }], 'lasso')
  const before: TileSnapshot = new Map(); clearMaskedSelection(layer, triangle, before)
  assert(pixel(layer, -5, -5)[3] === 0, 'Lasso did not delete inside')
  assert(pixel(layer, 25, 25).join() === '255,0,0,255', 'Lasso deleted outside its actual shape')
  restoreTiles(layer, before)
  assert(pixel(layer, -5, -5).join() === '255,0,0,255', 'Undo did not restore negative tiles / offset pixels')
  checks.push('lasso delete and undo across negative tiles with layer offsets')

  const ellipse = shapeSelection([{ x: 0, y: 0 }, { x: 24, y: 24 }], 'ellipse')
  const hole = shapeSelection([{ x: 12, y: 12 }], 'brush', 6)
  const donut = combineSelections(ellipse, hole, 'subtract')!
  drawMaskedImage(layer, solid('#0000ff', 24, 24), { x: 0, y: 0, width: 24, height: 24 }, donut, new Map(), true)
  assert(pixel(layer, 12, 12).join() === '255,0,0,255', 'Mask hole was overwritten')
  assert(pixel(layer, 12, 4).join() === '0,0,255,255', 'Selected ellipse pixels were not replaced')
  assert(pixel(layer, 1, 1).join() === '255,0,0,255', 'Ellipse bounding corner was overwritten')
  checks.push('ellipse replacement preserves holes and unselected pixels')

  paintMaskedSegment(layer, { x: 0, y: 12 }, { x: 24, y: 12 }, 4, '#00ff00', false, new Map(), donut)
  assert(pixel(layer, 12, 12).join() === '255,0,0,255', 'Brush painted inside a selection hole')
  assert(pixel(layer, 5, 12).join() === '0,255,0,255', 'Brush did not paint inside selection')
  paintMaskedSegment(layer, { x: 0, y: 12 }, { x: 24, y: 12 }, 4, '#fff', true, new Map(), donut)
  assert(pixel(layer, 5, 12)[3] === 0 && pixel(layer, 12, 12)[3] === 255, 'Eraser ignored selection')
  const tiles = layer.tiles.size
  paintMaskedSegment(layer, { x: 2000, y: 2000 }, { x: 2001, y: 2001 }, 4, '#fff', false, new Map(), donut)
  assert(layer.tiles.size === tiles, 'Painting outside selection allocated empty tiles')
  checks.push('masked brush and eraser, including no allocation outside selection')

  const union = combineSelections(ellipse, shapeSelection([{ x: 40, y: 12 }], 'brush', 8), 'add')!
  const intersect = combineSelections(union, rectangularSelection({ x: 0, y: 0, width: 24, height: 24 }), 'intersect')!
  const inverted = invertSelection(donut)
  const invertedMask = selectionMask(inverted, { x: 0, y: 0, width: 24, height: 24 })
  assert(alpha(selectionMask(union, { x: 0, y: 0, width: 48, height: 24 }), 40, 12) > 250, 'Selection add failed')
  assert(intersect.bounds.x + intersect.bounds.width <= 24, 'Selection intersect retained disjoint pixels')
  assert(alpha(invertedMask, 12, 12) === 255 && alpha(invertedMask, 12, 4) === 0, 'Selection invert lost its hole')
  assert(combineSelections(ellipse, ellipse, 'subtract') === null, 'Empty selection was not cleared')
  checks.push('selection add, subtract, intersection, bounded inversion and empty masks')

  const clone = createLayer('Clone')
  drawImageOnLayer(clone, solid('#ff0000', 8, 24), { x: 500, y: 0, width: 8, height: 24 })
  drawImageOnLayer(clone, solid('#0000ff', 32, 24), { x: 508, y: 0, width: 32, height: 24 })
  const frozen = snapshotLayer(clone), stampBefore: TileSnapshot = new Map()
  assert(pixel(frozen, 504, 12).join() === '255,0,0,255', `Clone source pixel missing: ${pixel(frozen, 504, 12)}`)
  cloneSegment(clone, frozen, { x: 512, y: 12 }, { x: 512, y: 12 }, { x: -8, y: 0 }, 6, stampBefore, null)
  assert(pixel(clone, 512, 12).join() === '255,0,0,255', `Initial clone stamp failed: ${pixel(clone, 512, 12)}`)
  cloneSegment(clone, frozen, { x: 512, y: 12 }, { x: 520, y: 12 }, { x: -8, y: 0 }, 6, stampBefore, null)
  assert(pixel(clone, 512, 12).join() === '255,0,0,255', `Clone did not sample source across tile seam: ${pixel(clone, 512, 12)}`)
  assert(pixel(clone, 520, 12).join() === '0,0,255,255', 'Clone fed its newly painted pixels back into source')
  restoreTiles(clone, stampBefore)
  assert(pixel(clone, 512, 12).join() === '0,0,255,255', 'Clone undo failed')
  checks.push('clone stamp freezes source, crosses tile seams and restores undo')

  const wandLayer = createLayer('Wand')
  drawImageOnLayer(wandLayer, solid('#fff', 16, 16), { x: 0, y: 0, width: 16, height: 16 })
  drawImageOnLayer(wandLayer, solid('#000', 2, 16), { x: 7, y: 0, width: 2, height: 16 })
  const wand = wandSelection(wandLayer, { x: 2, y: 2 }, 20, { x: 0, y: 0, width: 16, height: 16 })
  assert(alpha(wand.mask, 2, 2) === 255 && alpha(wand.mask, 12, 2) === 0, 'Wand selected a disconnected region')
  checks.push('magic wand uses connected color regions')

  const adjusted = createLayer('Adjust')
  drawImageOnLayer(adjusted, solid('#ff0000'), { x: 0, y: 0, width: 64, height: 64 })
  const adjustment = applyAdjustments([adjusted], donut.bounds, { ...defaultAdjustments, style: 'grayscale' }, donut)
  assert(adjustment.length === 1, 'Masked adjustment produced no edit')
  assert(pixel(adjusted, 12, 12).join() === '255,0,0,255', 'Color adjustment overwrote a selection hole')
  assert(pixel(adjusted, 12, 4)[0] === pixel(adjusted, 12, 4)[1], 'Selected color adjustment did not apply')
  checks.push('color adjustments retain actual selection holes')

  assert(sampleColor([adjusted], { x: 12, y: 12 }).color === '#ff0000', 'Eyedropper sampled wrong color')
  assert(sampleColor([adjusted], { x: -10, y: -10 }).alpha === 0, 'Eyedropper lost transparent alpha')
  const top = createLayer('Top'); top.opacity = 0.5; drawImageOnLayer(top, solid('#0000ff', 1, 1), { x: 12, y: 12, width: 1, height: 1 })
  const merged = sampleColor([adjusted, top], { x: 12, y: 12 })
  assert(merged.alpha === 1 && merged.color !== '#ff0000' && merged.color !== '#0000ff', 'Eyedropper ignored layer opacity')
  checks.push('eyedropper samples merged visible layers and alpha')

  const transparent = createLayer('Transparent'); drawImageOnLayer(transparent, solid('rgba(255, 0, 0, .5)', 8, 8), { x: 0, y: 0, width: 8, height: 8 })
  drawMaskedImage(transparent, solid('rgba(0, 0, 255, .5)', 8, 8), { x: 0, y: 0, width: 8, height: 8 }, rectangularSelection({ x: 0, y: 0, width: 8, height: 8 }), new Map(), true)
  assert(pixel(transparent, 4, 4)[3] === 128, 'Replacement doubled semitransparent alpha')
  checks.push('replacement preserves semitransparent alpha')
  return checks
}

Object.assign(window, { runRetouchChecks })

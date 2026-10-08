import { captureTile, createLayer, drawImageOnLayer, layerPixelBounds, rasterizeRegion, restoreTiles, type CanvasLayer, type TileSnapshot } from './canvas-engine'
import { applyEditingPixels, cropLayer, transformLayerContent } from './canvas-editing'
import { combineSelections, rectangularSelection, shapeSelection, snapshotLayer } from './canvas-retouch'

export function runEditingChecks(): string[] {
  const checks: string[] = []
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  const pixel = (layer: CanvasLayer, x: number, y: number) => [...rasterizeRegion([{ ...layer, visible: true, opacity: 1 }], { x, y, width: 1, height: 1 }, 1, 1).getContext('2d')!.getImageData(0, 0, 1, 1).data]
  const solid = (layer: CanvasLayer, color: string, x: number, y: number, width: number, height: number) => {
    const image = document.createElement('canvas'); image.width = width; image.height = height
    const ctx = image.getContext('2d')!; ctx.fillStyle = color; ctx.fillRect(0, 0, width, height)
    drawImageOnLayer(layer, image, { x, y, width, height })
  }
  const edit = (layer: CanvasLayer, input: Record<string, unknown>, mask: Parameters<typeof applyEditingPixels>[3] = null) => {
    const before: TileSnapshot = new Map()
    const bounds = applyEditingPixels(layer, snapshotLayer(layer), input, mask, before)
    const after: TileSnapshot = new Map([...before.keys()].map(key => [key, captureTile(layer, key)]))
    return { bounds, before, after }
  }
  const original = createLayer('Crop source'); original.offset = { x: 7, y: -5 }; original.opacity = 0.6
  solid(original, 'rgba(255,0,0,.5)', -32, -32, 64, 64)
  const selected = combineSelections(rectangularSelection({ x: -16, y: -16, width: 32, height: 32 }), shapeSelection([{ x: 0, y: 0 }], 'brush', 8), 'subtract')!
  const cropped = cropLayer(original, selected)
  assert(pixel(cropped, -10, -10).join() === '255,0,0,128', 'Crop lost selected color or alpha')
  assert(pixel(cropped, 0, 0)[3] === 0 && pixel(cropped, -20, -20)[3] === 0, 'Crop retained its hole or outside pixels')
  assert(pixel(original, 0, 0)[3] === 128 && pixel(original, -20, -20)[3] === 128, 'Crop mutated the undo source')
  assert(cropped.id === original.id && cropped.opacity === 0.6 && cropped.offset.x === 7 && cropped.name === original.name, 'Crop changed layer metadata')
  const explicit = cropLayer(original, null, { x: -8, y: -8, width: 16, height: 16 })
  assert(pixel(explicit, 0, 0)[3] === 128 && pixel(explicit, -10, -10)[3] === 0, 'Explicit crop failed')
  // The editor's layer history swaps immutable maps; both saved states must remain independently usable.
  for (const [state, alpha] of [[original, 128], [cropped, 0], [original, 128], [cropped, 0]] as const) assert(pixel(state, 0, 0)[3] === alpha, 'Crop undo/redo state was not preserved')
  checks.push('mask and rectangle crop retain world position, alpha, layer metadata and independent undo/redo states')

  const transform = createLayer('Transform source'); transform.offset = { x: 3, y: -5 }; transform.opacity = 0.7
  solid(transform, '#ff0000', -8, -4, 8, 8); solid(transform, '#0000ff', 0, -4, 8, 8)
  const rotated = transformLayerContent(transform, { transform: 'resize-rotate', targetWidth: 32, targetHeight: 16, angle: 90, smoothing: false })
  assert(rotated.bounds.x === -8 && rotated.bounds.y === -16 && rotated.bounds.width === 16 && rotated.bounds.height === 32, 'Resize/rotation lost the content center')
  assert(pixel(rotated.layer, 0, -10).join() === '255,0,0,255' && pixel(rotated.layer, 0, 10).join() === '0,0,255,255', 'Rotation direction or scaled content failed')
  assert(pixel(transform, -4, 0).join() === '255,0,0,255' && pixel(transform, 4, 0).join() === '0,0,255,255', 'Transform mutated original pixels')
  assert(rotated.layer.id === transform.id && rotated.layer.opacity === 0.7 && rotated.layer.offset.x === 3, 'Transform lost metadata')
  const flipped = transformLayerContent(transform, { transform: 'flip-x' }).layer
  assert(pixel(flipped, -4, 0).join() === '0,0,255,255', 'Legacy horizontal flip regressed')
  const quarter = transformLayerContent(transform, { transform: 'rotate' })
  assert(quarter.bounds.width === 8 && quarter.bounds.height === 16, 'Legacy quarter turn regressed')
  const diagonal = transformLayerContent(transform, { transform: 'resize-rotate', angle: 45 })
  assert(diagonal.bounds.width === 17 && diagonal.bounds.height === 17 && pixel(diagonal.layer, 0, 0)[3] > 200, 'Arbitrary rotation clipped content')
  assert(layerPixelBounds(rotated.layer)!.height === 32, 'Resized pixels have the wrong bounds')
  checks.push('layer resize and arbitrary clockwise rotation retain center, metadata and undo source; legacy transforms remain compatible')

  const mosaic = createLayer('Mosaic'); mosaic.offset = { x: 5, y: -3 }
  for (let x = -16; x < 32; x++) solid(mosaic, x % 2 === 0 ? '#ff0000' : '#0000ff', x, 0, 1, 32)
  const donut = combineSelections(rectangularSelection({ x: -8, y: 0, width: 32, height: 32 }), shapeSelection([{ x: 8, y: 16 }], 'brush', 8), 'subtract')!
  const pixels = edit(mosaic, { action: 'pixelate', blockSize: 8 }, donut)
  const mixed = pixel(mosaic, 0, 8)
  assert(Math.abs(mixed[0] - 128) <= 1 && Math.abs(mixed[2] - 128) <= 1, 'Mosaic did not average blocks')
  assert(pixel(mosaic, 8, 16).join() === '255,0,0,255' && pixel(mosaic, -12, 8).join() === '255,0,0,255', 'Mosaic overwrote a hole or unselected pixels')
  restoreTiles(mosaic, pixels.before); assert(pixel(mosaic, 0, 8).join() === '255,0,0,255', 'Mosaic undo failed')
  restoreTiles(mosaic, pixels.after); assert(pixel(mosaic, 0, 8).join() === mixed.join(), 'Mosaic redo failed')
  checks.push('world-aligned mosaic respects alpha, selection holes, layer offsets, undo and redo')

  const seam = createLayer(); seam.offset = { x: -2, y: 3 }
  for (let x = 496; x < 536; x++) solid(seam, x % 2 === 0 ? '#00ff00' : '#000000', x, 0, 1, 24)
  const frozen = snapshotLayer(seam), strokeBefore: TileSnapshot = new Map()
  applyEditingPixels(seam, frozen, { action: 'pixelate', points: [{ x: 504, y: 12 }, { x: 516, y: 12 }], brush: 12, blockSize: 8 }, null, strokeBefore)
  applyEditingPixels(seam, frozen, { action: 'pixelate', points: [{ x: 516, y: 12 }, { x: 528, y: 12 }], brush: 12, blockSize: 8 }, null, strokeBefore)
  assert(Math.abs(pixel(seam, 508, 12)[1] - 128) <= 1 && Math.abs(pixel(seam, 520, 12)[1] - 128) <= 1, 'Mosaic brush shifted block phase across tiles')
  assert(pixel(seam, 508, 2).join() === '0,255,0,255', 'Mosaic brush changed outside its stroke')
  restoreTiles(seam, strokeBefore); assert(pixel(seam, 508, 12).join() === '0,255,0,255', 'Mosaic cancelled stroke did not restore pixels')
  checks.push('mosaic brush keeps block alignment across tile seams and supports stroke cancellation')

  for (const exposureMode of ['dodge', 'burn']) {
    const exposure = createLayer(); exposure.offset = { x: 3, y: -6 }; solid(exposure, 'rgba(100,120,140,.5)', 0, 0, 32, 32)
    const before: TileSnapshot = new Map(), source = snapshotLayer(exposure), holePixel = pixel(exposure, 8, 16)
    const input = { action: 'exposure_brush', points: [{ x: 2, y: 16 }, { x: 30, y: 16 }], brush: 6, strength: 50, exposureMode }
    applyEditingPixels(exposure, source, input, donut, before)
    const first = pixel(exposure, 2, 16)
    applyEditingPixels(exposure, source, input, donut, before)
    assert(pixel(exposure, 2, 16).join() === first.join(), `${exposureMode} intensified when the stroke overlapped itself`)
    assert(exposureMode === 'dodge' ? first[0] > 100 : first[0] < 100, `${exposureMode} changed brightness in the wrong direction`)
    assert(first[3] === 128 && pixel(exposure, 8, 16).join() === holePixel.join() && pixel(exposure, 40, 8)[3] === 0, `${exposureMode} lost alpha or edited outside content`)
    const after: TileSnapshot = new Map([...before.keys()].map(key => [key, captureTile(exposure, key)]))
    restoreTiles(exposure, before); assert(Math.abs(pixel(exposure, 2, 16)[0] - 100) <= 1, `${exposureMode} undo failed`)
    restoreTiles(exposure, after); assert(pixel(exposure, 2, 16).join() === first.join(), `${exposureMode} redo failed`)
    checks.push(`${exposureMode} exposure uses frozen stroke pixels, preserves alpha, respects masks, undo and redo`)
  }

  const invalid = createLayer(); solid(invalid, '#ff0000', 0, 0, 8, 8)
  for (const input of [
    { action: 'pixelate', blockSize: 0 }, { action: 'pixelate', x: 0, y: 0, width: 5000, height: 10 },
    { action: 'exposure_brush', points: [{ x: NaN, y: 0 }] }, { action: 'exposure_brush', x: 0, y: 0, strength: 101 },
  ]) {
    const before: TileSnapshot = new Map(); let failed = false
    try { applyEditingPixels(invalid, snapshotLayer(invalid), input, null, before) } catch { failed = true }
    assert(failed && before.size === 0 && pixel(invalid, 4, 4).join() === '255,0,0,255', 'Invalid pixel operation mutated the layer')
  }
  let rejected = false
  try { transformLayerContent(invalid, { transform: 'resize-rotate', targetWidth: 4096, targetHeight: 4096, angle: 45 }) } catch { rejected = true }
  assert(rejected && pixel(invalid, 4, 4).join() === '255,0,0,255', 'Oversized rotated output mutated source')
  checks.push('crop, transform, mosaic and exposure reject invalid operations without partial edits')
  return checks
}

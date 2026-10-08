import { describe, expect, it } from 'bun:test'
import { blendSelectionPixels, checkedSelectionBounds, contiguousColorMask, pathBounds } from './canvas-retouch'

function image(width: number, height: number, color: number[]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set(color, i)
  return { width, height, data } as ImageData
}

describe('retouch pixel operations', () => {
  it('keeps disconnected matching colors outside the wand selection', () => {
    const source = image(5, 3, [240, 240, 240, 255])
    for (let y = 0; y < 3; y++) source.data.set([20, 20, 20, 255], (y * 5 + 2) * 4)
    expect([...contiguousColorMask(source, { x: 0, y: 1 }, 20)]).toEqual([
      255, 255, 0, 0, 0, 255, 255, 0, 0, 0, 255, 255, 0, 0, 0,
    ])
  })

  it('distinguishes transparent pixels from opaque pixels of the same color', () => {
    const source = image(3, 1, [0, 0, 0, 0]); source.data[7] = 255
    expect([...contiguousColorMask(source, { x: 0, y: 0 }, 100)]).toEqual([255, 0, 0])
    expect([...contiguousColorMask(source, { x: -1, y: 0 }, 100)]).toEqual([0, 0, 0])
  })

  it('retains unselected pixels and holes exactly when applying generated pixels', () => {
    const original = image(3, 1, [23, 81, 170, 128]), generated = image(3, 1, [255, 0, 0, 255]), mask = image(3, 1, [255, 255, 255, 0])
    mask.data[7] = 255
    blendSelectionPixels(generated, original, mask)
    expect([...generated.data]).toEqual([23, 81, 170, 128, 255, 0, 0, 255, 23, 81, 170, 128])
  })

  it('blends antialiased edges without darkening transparent colors', () => {
    const original = image(1, 1, [0, 0, 0, 0]), generated = image(1, 1, [255, 180, 20, 255]), mask = image(1, 1, [255, 255, 255, 128])
    blendSelectionPixels(generated, original, mask)
    expect([...generated.data]).toEqual([255, 180, 20, 128])
    expect(() => blendSelectionPixels(generated, image(2, 1, [0, 0, 0, 0]), mask)).toThrow()
  })

  it('bounds strokes at negative coordinates and rejects unsafe allocations', () => {
    expect(pathBounds([{ x: -3.5, y: -4.25 }, { x: 4, y: 6 }], 2)).toEqual({ x: -6, y: -7, width: 12, height: 15 })
    expect(() => checkedSelectionBounds({ x: 0, y: 0, width: 4097, height: 100 })).toThrow()
    expect(() => checkedSelectionBounds({ x: 1e100, y: 0, width: 20, height: 20 })).toThrow()
    expect(() => pathBounds([{ x: NaN, y: 0 }])).toThrow()
  })
})

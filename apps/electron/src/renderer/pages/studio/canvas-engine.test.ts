import { describe, expect, it } from 'bun:test'
import { normalizeRect, removeEdgeBackground, tileRange } from './canvas-engine'

describe('infinite canvas geometry', () => {
  it('maps negative world coordinates to tiles without allocating a fixed canvas', () => {
    expect(tileRange({ x: -513, y: -1, width: 1026, height: 2 })).toEqual({ left: -2, top: -1, right: 1, bottom: 0 })
    expect(tileRange({ x: 1_000_000, y: -1_000_000, width: 1, height: 1 })).toEqual({ left: 1953, top: -1954, right: 1953, bottom: -1954 })
    expect(normalizeRect({ x: 40, y: 20 }, { x: -10, y: 5 })).toEqual({ x: -10, y: 5, width: 50, height: 15 })
  })

  it('removes only edge-connected background and keeps an isolated subject', () => {
    const width = 5, height = 5, data = new Uint8ClampedArray(width * height * 4)
    for (let index = 0; index < width * height; index++) {
      const at = index * 4
      data[at] = data[at + 1] = data[at + 2] = 240
      data[at + 3] = 255
    }
    const center = (2 * width + 2) * 4
    data[center] = data[center + 1] = data[center + 2] = 20
    const removed = removeEdgeBackground({ data, width, height } as ImageData, 20)
    expect(removed).toBe(24)
    expect(data[center + 3]).toBe(255)
  })
})

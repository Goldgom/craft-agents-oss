import { describe, expect, it } from 'bun:test'
import { adjustPixelData, adjustmentEditArea, adjustmentsAreNeutral, defaultAdjustments } from './studio-adjustments'

describe('canvas adjustments', () => {
  it('keeps the original pixels when the controls are neutral', () => {
    const pixels = new Uint8ClampedArray([60, 120, 180, 128, 0, 0, 0, 0])
    expect(adjustmentsAreNeutral(defaultAdjustments)).toBe(true)
    adjustPixelData(pixels, defaultAdjustments)
    expect([...pixels]).toEqual([60, 120, 180, 128, 0, 0, 0, 0])
  })

  it('preserves transparency while changing colors and applying a style', () => {
    const pixels = new Uint8ClampedArray([255, 0, 0, 128, 12, 34, 56, 0])
    adjustPixelData(pixels, { ...defaultAdjustments, style: 'grayscale' })
    expect(pixels[0]).toBe(pixels[1])
    expect(pixels[1]).toBe(pixels[2])
    expect(pixels[3]).toBe(128)
    expect([...pixels.slice(4)]).toEqual([12, 34, 56, 0])
  })

  it('changes warmth and saturation without changing alpha', () => {
    const pixels = new Uint8ClampedArray([80, 120, 160, 255])
    adjustPixelData(pixels, { ...defaultAdjustments, saturation: 0, temperature: 60 })
    expect(pixels[0]).toBeGreaterThan(pixels[2])
    expect(pixels[3]).toBe(255)
  })

  it('limits selected edits to each affected tile and covers entire tiles without a selection', () => {
    const selection = { x: 510, y: 2, width: 4, height: 2 }
    expect(adjustmentEditArea(0, 0, selection, { x: 0, y: 0 })).toEqual({ x: 510, y: 2, width: 2, height: 2 })
    expect(adjustmentEditArea(1, 0, selection, { x: 0, y: 0 })).toEqual({ x: 0, y: 2, width: 2, height: 2 })
    expect(adjustmentEditArea(0, 0, null, { x: 0, y: 0 })).toEqual({ x: 0, y: 0, width: 512, height: 512 })
  })
})

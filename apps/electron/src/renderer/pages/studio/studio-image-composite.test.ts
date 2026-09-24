import { describe, expect, it } from 'bun:test'
import { assessEditOutput, composeInpaint, composeOutpaint, fillTransparentForEdit, referenceCoverage } from './studio-image-composite'

function frame(width: number, height: number, color: [number, number, number, number]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index++) data.set(color, index * 4)
  return { width, height, data } as ImageData
}

function pixel(image: ImageData, x: number, y: number): number[] {
  return [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)]
}

describe('AI replacement compositing', () => {
  it('preserves boundary pixels, blends the seam, and replaces the center', () => {
    const generated = frame(5, 5, [255, 0, 0, 255])
    const original = frame(5, 5, [0, 0, 255, 255])
    composeInpaint(generated, original, 2)
    expect(pixel(generated, 2, 0)).toEqual([0, 0, 255, 255])
    expect(pixel(generated, 2, 1)).toEqual([128, 0, 128, 255])
    expect(pixel(generated, 2, 2)).toEqual([255, 0, 0, 255])
  })

  it('fills empty pixels without introducing a dark transparent halo', () => {
    const generated = frame(5, 1, [255, 0, 0, 255])
    const original = frame(5, 1, [0, 0, 255, 255])
    original.data[3 * 4 + 3] = 0
    original.data[4 * 4 + 3] = 0
    composeOutpaint(generated, original, 2)
    expect(pixel(generated, 0, 0)).toEqual([0, 0, 255, 255])
    expect(pixel(generated, 1, 0)).toEqual([0, 0, 255, 255])
    expect(pixel(generated, 2, 0)).toEqual([128, 0, 128, 255])
    expect(pixel(generated, 3, 0)).toEqual([255, 0, 0, 255])
  })

  it('keeps partially transparent original edges when generated output is transparent', () => {
    const generated = frame(3, 3, [255, 0, 0, 0])
    const original = frame(3, 3, [0, 255, 0, 128])
    composeInpaint(generated, original, 1)
    expect(pixel(generated, 1, 0)).toEqual([0, 255, 0, 128])
    expect(pixel(generated, 1, 1)[3]).toBe(0)
  })

  it('gives a transparent manga canvas an opaque white edit background', () => {
    const source = frame(8, 8, [0, 0, 0, 0])
    for (let y = 0; y < 8; y++) for (let x = 4; x < 8; x++) {
      source.data.set([255, 255, 255, 255], (y * 8 + x) * 4)
    }
    expect(fillTransparentForEdit(source)).toEqual([255, 255, 255])
    expect(pixel(source, 0, 4)).toEqual([255, 255, 255, 255])
    expect(pixel(source, 7, 4)).toEqual([255, 255, 255, 255])
  })

  it('rejects an opaque black block returned for a white masked canvas', () => {
    const source = frame(32, 32, [255, 255, 255, 255])
    const mask = frame(32, 32, [255, 255, 255, 255])
    const returned = frame(32, 32, [255, 255, 255, 255])
    for (let y = 0; y < 32; y++) for (let x = 0; x < 16; x++) {
      mask.data[(y * 32 + x) * 4 + 3] = 0
      returned.data.set([0, 0, 0, 255], (y * 32 + x) * 4)
    }
    expect(assessEditOutput(returned, source, mask)).toBe('black-fill')
  })

  it('rejects a provider response that repaints the protected image', () => {
    const source = frame(32, 32, [255, 255, 255, 255])
    const mask = frame(32, 32, [255, 255, 255, 255])
    const returned = frame(32, 32, [0, 0, 0, 255])
    expect(assessEditOutput(returned, source, mask)).toBe('ignored-mask')
    returned.data.set(source.data)
    expect(assessEditOutput(returned, source, mask)).toBeNull()
  })

  it('detects when a large expansion contains too little image context', () => {
    const source = frame(128, 128, [0, 0, 0, 0])
    for (let y = 0; y < 128; y++) source.data[(y * 128 + 127) * 4 + 3] = 255
    expect(referenceCoverage(source)).toBe(0.125)
    const empty = frame(128, 128, [0, 0, 0, 0])
    expect(referenceCoverage(empty)).toBe(0)
  })
})

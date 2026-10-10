import { describe, expect, it } from 'bun:test'
import { createLayer } from './canvas-engine'
import { applyEditingPixels, cropLayer, exposurePixels, pixelatePixels, resizeDimensions, transformedBounds, transformLayerContent } from './canvas-editing'

describe('layer geometry and local retouch', () => {
  it('keeps the locked aspect ratio when either dimension reaches the pixel limits', () => {
    expect(resizeDimensions(100, 200, 'width', 4096, true)).toEqual({ width: 2048, height: 4096 })
    expect(resizeDimensions(200, 100, 'height', 4096, true)).toEqual({ width: 4096, height: 2048 })
    expect(resizeDimensions(100, 200, 'height', 0, true)).toEqual({ width: 1, height: 2 })
    expect(resizeDimensions(100, 200, 'width', 500, false)).toEqual({ width: 500, height: 200 })
  })
  it('keeps the content center and fits a resized and rotated image', () => {
    expect(transformedBounds({ x: -8, y: -4, width: 16, height: 8 }, 32, 16, 90)).toEqual({ x: -8, y: -16, width: 16, height: 32 })
    const diagonal = transformedBounds({ x: 0, y: 0, width: 100, height: 100 }, 100, 100, 45)
    expect(diagonal.width).toBe(142); expect(diagonal.height).toBe(142)
    expect(diagonal.x + diagonal.width / 2).toBe(50)
    expect(() => transformedBounds({ x: 0, y: 0, width: 10, height: 10 }, 4096, 4096, 45)).toThrow()
    expect(() => transformedBounds({ x: 0, y: 0, width: 10, height: 10 }, NaN, 100, 0)).toThrow()
  })
  it('mosaic averages alpha-weighted color without spreading or changing transparency', () => {
    const image = { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 128, 0, 255, 0, 0, 0, 0, 0, 0]) } as ImageData
    pixelatePixels(image, 2)
    expect([...image.data]).toEqual([170, 0, 85, 255, 170, 0, 85, 128, 0, 255, 0, 0, 0, 0, 0, 0])
    expect(() => pixelatePixels(image, 2.5)).toThrow()
  })
  it('dodge and burn act in opposite directions while retaining alpha and transparent pixels', () => {
    const source = new Uint8ClampedArray([100, 120, 140, 128, 30, 40, 50, 0]), dodge = source.slice(), burn = source.slice()
    exposurePixels(dodge, 'dodge', 20); exposurePixels(burn, 'burn', 20)
    expect([...dodge]).toEqual([131, 147, 163, 128, 30, 40, 50, 0])
    expect([...burn]).toEqual([80, 96, 112, 128, 30, 40, 50, 0])
    expect(() => exposurePixels(dodge, 'dodge', 101)).toThrow()
  })
  it('crop requires an explicit bounded scope and never mutates an invalid source', () => {
    const layer = createLayer()
    expect(() => cropLayer(layer, null)).toThrow()
    expect(() => cropLayer(layer, null, { x: 0, y: 0, width: 5000, height: 10 })).toThrow()
    expect(layer.tiles.size).toBe(0)
  })
  it('all four tools refuse to edit hidden layers', () => {
    const layer = createLayer(); layer.visible = false
    expect(() => cropLayer(layer, null)).toThrow()
    expect(() => transformLayerContent(layer, { transform: 'rotate' })).toThrow()
    for (const action of ['pixelate', 'exposure_brush']) expect(() => applyEditingPixels(layer, layer, { action }, null, new Map())).toThrow()
    expect(layer.tiles.size).toBe(0)
  })
})

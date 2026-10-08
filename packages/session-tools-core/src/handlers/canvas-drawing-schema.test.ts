import { describe, expect, it } from 'bun:test'
import { CanvasToolSchema } from '../tool-defs'
import { handleCanvasTool } from './canvas-tool'
import type { SessionToolContext } from '../context'

describe('drawing AI interfaces', () => {
  const examples: Array<ReturnType<typeof CanvasToolSchema.parse>> = [
    { action: 'draw_text', x: -20, y: 30, text: '标题\n说明', fontSize: 48, fontFamily: 'serif', bold: true, color: '#123456' },
    { action: 'draw_shape', shape: 'arrow', x: 0, y: 0, toX: 100, toY: 30, brush: 6, filled: false, color: '#123456' },
    { action: 'fill_region', x: -10, y: 30, boundsX: -20, boundsY: 20, width: 200, height: 100, tolerance: 20, color: '#123456' },
    { action: 'draw_gradient', x: 0, y: 0, toX: 100, toY: 100, gradientKind: 'radial', color: '#123456', secondaryColor: '#abcdef' },
    { action: 'crop_layer', x: -20, y: 10, width: 200, height: 100 },
    { action: 'transform_layer', transform: 'resize-rotate', targetWidth: 200, targetHeight: 100, angle: 45, smoothing: false },
    { action: 'pixelate', points: [{ x: -20, y: 10 }, { x: 40, y: 30 }], brush: 24, blockSize: 12 },
    { action: 'exposure_brush', points: [{ x: 10, y: 20 }], brush: 12, exposureMode: 'burn', strength: 25 },
  ]
  for (const example of examples) {
    it(`${example.action} preserves every parameter across the desktop bridge`, async () => {
      const args = CanvasToolSchema.parse(example)
      expect(args).toEqual(example)
      let received: unknown
      const response = await handleCanvasTool({ canvasToolFn: async input => { received = input; return { applied: true } } } as SessionToolContext, args)
      expect(received).toEqual(example)
      expect(response.isError).not.toBe(true)
    })
  }
  it('rejects invalid drawing-specific parameters at the AI boundary', () => {
    for (const input of [
      { action: 'draw_text', text: 'a'.repeat(2001) }, { action: 'draw_text', fontSize: 0 },
      { action: 'draw_text', fontSize: Infinity }, { action: 'draw_text', fontFamily: 'url(font)' },
      { action: 'draw_shape', shape: 'unknown' }, { action: 'draw_shape', filled: 'true' },
      { action: 'fill_region', tolerance: -1 }, { action: 'fill_region', boundsX: Infinity },
      { action: 'transform_layer', targetWidth: 5000 }, { action: 'transform_layer', angle: Infinity },
      { action: 'transform_layer', transform: 'invalid' }, { action: 'pixelate', blockSize: 1.5 },
      { action: 'exposure_brush', strength: 101 }, { action: 'exposure_brush', exposureMode: 'unknown' },
      { action: 'draw_gradient', gradientKind: 'unknown' }, { action: 'draw_gradient', secondaryColor: 'red' },
    ]) expect(CanvasToolSchema.safeParse(input).success).toBe(false)
  })
  for (const example of examples) {
    it(`${example.action} reports desktop execution failure`, async () => {
      const response = await handleCanvasTool({ canvasToolFn: async () => { throw new Error('Invalid drawing bounds') } } as unknown as SessionToolContext, example)
      expect(response.isError).toBe(true)
    })
  }
})

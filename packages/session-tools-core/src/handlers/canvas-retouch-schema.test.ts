import { describe, expect, it } from 'bun:test'
import { CanvasToolSchema } from '../tool-defs'
import { handleCanvasTool } from './canvas-tool'
import type { SessionToolContext } from '../context'

describe('canvas retouch AI interface', () => {
  it('exposes selection, repair and color operations through the real tool schema', () => {
    for (const action of ['list_tools', 'select_lasso', 'select_brush', 'select_ellipse', 'select_wand', 'invert_selection', 'export_selection_mask', 'delete_pixels', 'clone_stamp', 'sample_color']) {
      expect(CanvasToolSchema.safeParse({ action }).success).toBe(true)
    }
    expect(CanvasToolSchema.safeParse({ action: 'select_brush', selectionMode: 'subtract', points: [{ x: -10, y: 20 }], brush: 24 }).success).toBe(true)
    expect(CanvasToolSchema.safeParse({ action: 'select_brush', selectionMode: 'invalid' }).success).toBe(false)
    expect(CanvasToolSchema.safeParse({ action: 'clone_stamp', sourceX: Infinity, sourceY: 20 }).success).toBe(false)
    expect(CanvasToolSchema.safeParse({ action: 'select_brush', brush: 10000 }).success).toBe(false)
  })

  it('delivers clone source coordinates and selection combination modes to the desktop capability', async () => {
    const args = CanvasToolSchema.parse({ action: 'clone_stamp', sourceX: -20, sourceY: 30, points: [{ x: 80, y: 90 }], brush: 16 })
    let received: Record<string, unknown> | undefined
    const result = await handleCanvasTool({ canvasToolFn: async input => { received = input; return { painted: true } } } as SessionToolContext, args)
    expect(received).toEqual(args)
    expect(result.isError).not.toBe(true)
  })
})

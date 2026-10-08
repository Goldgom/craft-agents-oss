import { describe, expect, it } from 'bun:test'
import { canvasToolGroups } from './canvas-tools'
import { CanvasToolSchema } from '../../../../../../packages/session-tools-core/src/tool-defs'
import { applyDrawingCommand } from './canvas-drawing'
import { createLayer } from './canvas-engine'
import { contiguousColorMask } from './canvas-retouch'

describe('drawing tools', () => {
  it('provides unique tools and keyboard shortcuts, with an AI action for every tool', () => {
    const tools = canvasToolGroups.flatMap(group => group.tools)
    expect(new Set(tools.map(tool => tool.id)).size).toBe(tools.length)
    const shortcuts = tools.flatMap(tool => tool.shortcut ? [tool.shortcut] : [])
    expect(new Set(shortcuts).size).toBe(shortcuts.length)
    for (const tool of tools) {
      expect(tool.actions.length).toBeGreaterThan(0)
      for (const action of tool.actions) expect(CanvasToolSchema.safeParse({ action }).success).toBe(true)
    }
    for (const [id, action] of [['text', 'draw_text'], ['shape', 'draw_shape'], ['fill', 'fill_region'], ['gradient', 'draw_gradient'], ['crop', 'crop_layer'], ['transform', 'transform_layer'], ['mosaic', 'pixelate'], ['exposure', 'exposure_brush']]) {
      expect(tools.find(tool => tool.id === id)?.actions).toContain(action)
    }
    expect(tools.some(tool => (tool.id as string) === 'delete')).toBe(false)
    expect(tools.find(tool => tool.id === 'erase')?.actions).toContain('delete_pixels')
  })

  it('prevents flood fill from reaching another island through unselected pixels', () => {
    const data = new Uint8ClampedArray(5 * 4).fill(255)
    const allowed = data.slice(); allowed[2 * 4 + 3] = 0
    const image = { data, width: 5, height: 1 } as ImageData
    expect([...contiguousColorMask(image, { x: 0, y: 0 }, 0, allowed)]).toEqual([255, 255, 0, 0, 0])
    expect([...contiguousColorMask(image, { x: 2, y: 0 }, 0, allowed)]).toEqual([0, 0, 0, 0, 0])
  })

  for (const action of ['fill_region', 'draw_text', 'draw_shape', 'draw_gradient']) {
    it(`${action} rejects hidden layers and invalid coordinates without mutating tiles`, () => {
      const layer = createLayer(); layer.visible = false
      expect(() => applyDrawingCommand(layer, { action, x: 0, y: 0 }, null, new Map())).toThrow()
      layer.visible = true
      expect(() => applyDrawingCommand(layer, { action, x: Infinity, y: 0 }, null, new Map())).toThrow()
      expect(layer.tiles.size).toBe(0)
    })
  }
})

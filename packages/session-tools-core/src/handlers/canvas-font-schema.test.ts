import { describe, expect, it } from 'bun:test'
import { CanvasToolSchema, getToolDefsAsJsonSchema } from '../tool-defs'

describe('canvas font schema compatibility', () => {
  it('exports font lengths without a Unicode property regex that providers reject', () => {
    const tool = getToolDefsAsJsonSchema({ prefix: 'mcp__session__' })
      .find(def => def.name === 'mcp__session__canvas_tool')!
    const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>
    expect(properties.fontFamily).toMatchObject({ type: 'string', minLength: 1, maxLength: 80 })
    expect(properties.fontFamily).not.toHaveProperty('pattern')
  })

  it('still validates Unicode font names and rejects unsafe or oversized input locally', () => {
    for (const fontFamily of ['Arial', 'sans-serif', 'Noto Sans CJK SC', '微软雅黑', 'ＭＳ ゴシック', 'École_123', '𠮷体']) {
      expect(CanvasToolSchema.safeParse({ action: 'draw_text', fontFamily }).success).toBe(true)
    }
    for (const fontFamily of ['', 'a'.repeat(81), 'Arial; color:red', '"Arial"', 'Arial,serif', 'Arial\n', '😀']) {
      expect(CanvasToolSchema.safeParse({ action: 'draw_text', fontFamily }).success).toBe(false)
    }
    expect(CanvasToolSchema.safeParse({ action: 'draw_text' }).success).toBe(true)
  })
})

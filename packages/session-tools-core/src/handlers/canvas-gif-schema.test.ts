import { expect, test } from 'bun:test'
import { CanvasToolSchema } from '../tool-defs'
import { handleCanvasTool } from './canvas-tool'
import type { SessionToolContext } from '../context'

test('GIF options survive the AI tool bridge', async () => {
  const input = { action: 'generate_gif' as const, gifMode: 'layers' as const, layerIds: ['second', 'first'], frameDelay: 120,
    repeat: -1, maxSize: 256, outputPath: 'C:\\exports\\selection.gif' }
  const parsed = CanvasToolSchema.parse(input)
  expect(parsed).toEqual(input)
  let received: unknown
  const result = await handleCanvasTool({ canvasToolFn: async args => { received = args; return { saved: true } } } as SessionToolContext, parsed)
  expect(result.isError).not.toBe(true)
  expect(received).toEqual(input)
})

test('GIF schema rejects invalid mode, timing, size and frame counts', () => {
  for (const options of [{ gifMode: 'video' }, { frameDelay: 0 }, { frameDelay: 2001 }, { repeat: -2 },
    { maxSize: 1025 }, { maxSize: 0 }, { frameCount: 1 }, { frameCount: 61 }, { frameCount: 2.5 }]) {
    expect(CanvasToolSchema.safeParse({ action: 'generate_gif', ...options }).success).toBe(false)
  }
})

import { describe, expect, it } from 'bun:test'
import type { ImageProcessor } from '../runtime/platform'
import { inspectImageBuffer, resizeImageForAPI, setImageProcessor } from './image-utils'

const buffer = Buffer.from('test-image')

describe('inspectImageBuffer', () => {
  it('returns ok when metadata is available', async () => {
    const processor: ImageProcessor = {
      getMetadata: async () => ({ width: 640, height: 480 }),
      process: async () => Buffer.from('unused'),
    }

    await expect(inspectImageBuffer(buffer, processor)).resolves.toEqual({
      status: 'ok',
      width: 640,
      height: 480,
    })
  })

  it('returns invalid_image when the processor can run but the input is unreadable', async () => {
    const processor: ImageProcessor = {
      getMetadata: async () => null,
      process: async () => {
        throw new Error('Input buffer contains unsupported image format')
      },
    }

    await expect(inspectImageBuffer(buffer, processor)).resolves.toMatchObject({
      status: 'invalid_image',
    })
  })

  it('returns processor_unavailable when image processing support is missing', async () => {
    const processor: ImageProcessor = {
      getMetadata: async () => null,
      process: async () => {
        throw new Error("Cannot find package 'sharp' imported from image-utils")
      },
    }

    await expect(inspectImageBuffer(buffer, processor)).resolves.toMatchObject({
      status: 'processor_unavailable',
    })
  })
})

describe('resizeImageForAPI', () => {
  it('progressively reduces dimensions until it reaches a small upload target', async () => {
    const calls: Array<{ width?: number; quality?: number }> = []
    const processor: ImageProcessor = {
      getMetadata: async () => ({ width: 2400, height: 1600 }),
      process: async (_input, options) => {
        calls.push({ width: options?.resize?.width, quality: options?.quality })
        const width = options?.resize?.width ?? 2400
        const quality = options?.quality ?? 100
        return Buffer.alloc(Math.round(width * quality * 0.8))
      },
    }
    setImageProcessor(processor)

    const result = await resizeImageForAPI(Buffer.alloc(600_000), {
      maxSizeBytes: 100 * 1024,
      bestEffort: true,
    })

    expect(result).not.toBeNull()
    expect(result!.buffer.length).toBeLessThanOrEqual(100 * 1024)
    expect(result!.format).toBe('jpeg')
    expect(calls.length).toBeGreaterThan(2)
  })

  it('returns the smallest candidate in best-effort mode', async () => {
    const processor: ImageProcessor = {
      getMetadata: async () => ({ width: 1000, height: 800 }),
      process: async (_input, options) => Buffer.alloc(options?.format === 'jpeg' ? 140_000 : 250_000),
    }
    setImageProcessor(processor)

    const result = await resizeImageForAPI(Buffer.alloc(500_000), {
      maxSizeBytes: 100 * 1024,
      bestEffort: true,
    })
    expect(result?.buffer.length).toBe(140_000)
    expect(result?.format).toBe('jpeg')
  })
})

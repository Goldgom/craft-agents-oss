import type { ImageProcessor } from '../runtime/platform'
import { IMAGE_LIMITS } from '@craft-agent/shared/utils'

export interface ImageResizeResult {
  /** Resized image buffer */
  buffer: Buffer
  /** Output dimensions */
  width: number
  height: number
  /** Output format */
  format: 'png' | 'jpeg'
}

let imageProcessor: ImageProcessor

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isImageProcessorUnavailableError(error: unknown): boolean {
  const message = toError(error).message.toLowerCase()
  return (
    (message.includes('cannot find package') || message.includes('cannot find module'))
    && message.includes('sharp')
  )
}

export type ImageBufferInspection =
  | { status: 'ok'; width: number; height: number }
  | { status: 'invalid_image'; error?: Error }
  | { status: 'processor_unavailable'; error?: Error }

/**
 * Inspect an uploaded image buffer and distinguish between invalid input and
 * unavailable image-processing support.
 */
export async function inspectImageBuffer(
  buffer: Buffer,
  processor: ImageProcessor,
): Promise<ImageBufferInspection> {
  try {
    const metadata = await processor.getMetadata(buffer)
    if (metadata?.width && metadata?.height) {
      return { status: 'ok', width: metadata.width, height: metadata.height }
    }
  } catch (error) {
    if (isImageProcessorUnavailableError(error)) {
      return { status: 'processor_unavailable', error: toError(error) }
    }
  }

  try {
    const normalized = await processor.process(buffer, { format: 'png' })
    const metadata = await processor.getMetadata(normalized)
    if (metadata?.width && metadata?.height) {
      return { status: 'ok', width: metadata.width, height: metadata.height }
    }
    return { status: 'invalid_image' }
  } catch (error) {
    if (isImageProcessorUnavailableError(error)) {
      return { status: 'processor_unavailable', error: toError(error) }
    }
    return { status: 'invalid_image', error: toError(error) }
  }
}

export function setImageProcessor(proc: ImageProcessor) {
  imageProcessor = proc
}

/**
 * Get image dimensions from a buffer.
 * Returns { width, height } or null if the buffer is not a valid image.
 */
export async function getImageSize(buffer: Buffer): Promise<{ width: number; height: number } | null> {
  try {
    return await imageProcessor.getMetadata(buffer)
  } catch {
    return null
  }
}

/**
 * Resize an image buffer to fit within maxSize×maxSize, output as PNG.
 * Returns the resized PNG buffer, or undefined if the input is invalid.
 */
export async function resizeIconBuffer(buffer: Buffer, targetSize: number): Promise<Buffer | undefined> {
  try {
    return await imageProcessor.process(buffer, {
      resize: { width: targetSize, height: targetSize },
      fit: 'inside',
      format: 'png',
    })
  } catch {
    return undefined
  }
}

/**
 * Resize and/or compress an image buffer to fit within Claude API limits.
 *
 * Strategy:
 * 1. If dimensions exceed OPTIMAL_EDGE (1568px), resize down
 * 2. Output as PNG (or JPEG if isPhoto)
 * 3. If still over maxSizeBytes, try JPEG at 90 quality
 * 4. If still over, try JPEG at 75 quality
 * 5. If still over, return null (can't fix)
 *
 * @returns Resized image data, or null if image can't be made small enough
 */
export async function resizeImageForAPI(
  buffer: Buffer,
  options?: {
    /** Max output size in bytes. Default: IMAGE_LIMITS.MAX_SIZE (5MB) */
    maxSizeBytes?: number
    /** Prefer JPEG output (for photos). Default: false */
    isPhoto?: boolean
    /** Return the smallest candidate when the requested target cannot be reached. */
    bestEffort?: boolean
  },
): Promise<ImageResizeResult | null> {
  const maxSize = options?.maxSizeBytes ?? IMAGE_LIMITS.MAX_SIZE
  const isPhoto = options?.isPhoto ?? false

  const metadata = await imageProcessor.getMetadata(buffer).catch(() => null)
  if (!metadata) return null

  const maxEdge = Math.max(metadata.width, metadata.height)

  // Step 1: Compute target dimensions if resize needed
  let outWidth = metadata.width
  let outHeight = metadata.height

  if (maxEdge > IMAGE_LIMITS.OPTIMAL_EDGE) {
    const scale = IMAGE_LIMITS.OPTIMAL_EDGE / maxEdge
    outWidth = Math.round(metadata.width * scale)
    outHeight = Math.round(metadata.height * scale)
  }

  const needsResize = outWidth !== metadata.width || outHeight !== metadata.height

  // Step 2: Encode — try preferred format first. Keep the smallest candidate
  // so optional upload compression can remain best-effort instead of rejecting
  // an otherwise valid image.
  let output: Buffer
  let format: 'png' | 'jpeg'

  if (isPhoto) {
    output = await imageProcessor.process(buffer, {
      ...(needsResize && { resize: { width: outWidth, height: outHeight } }),
      format: 'jpeg',
      quality: IMAGE_LIMITS.JPEG_QUALITY_HIGH,
    })
    format = 'jpeg'
  } else {
    output = await imageProcessor.process(buffer, {
      ...(needsResize && { resize: { width: outWidth, height: outHeight } }),
      format: 'png',
    })
    format = 'png'
  }

  let best: ImageResizeResult = { buffer: output, width: outWidth, height: outHeight, format }
  if (output.length <= maxSize) return best

  // Step 3-4: progressively lower JPEG quality and dimensions. A 100KB upload
  // target often needs both; the old two-quality pass could not get large phone
  // screenshots close enough to the target.
  const qualities = [85, 72, 60, 48, 36, 28]
  let width = outWidth
  let height = outHeight
  for (let index = 0; index < qualities.length; index += 1) {
    if (index > 0) {
      width = Math.max(320, Math.round(width * 0.78))
      height = Math.max(240, Math.round(height * 0.78))
    }

    const candidate = await imageProcessor.process(buffer, {
      resize: { width, height },
      fit: 'inside',
      format: 'jpeg',
      quality: qualities[index],
    })
    if (candidate.length < best.buffer.length) {
      best = { buffer: candidate, width, height, format: 'jpeg' }
    }
    if (candidate.length <= maxSize) {
      return { buffer: candidate, width, height, format: 'jpeg' }
    }

    if (width === 320 && height === 240) break
  }

  // Step 5: Mandatory API-limit callers still fail closed. Optional upload
  // compression callers keep the smallest safe candidate they could produce.
  return options?.bestEffort ? best : null
}

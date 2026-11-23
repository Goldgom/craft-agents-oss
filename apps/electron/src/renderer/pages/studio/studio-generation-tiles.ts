import { MAX_RASTER_SIDE, rasterizeRegion, tileRange, type CanvasLayer, type Rect } from './canvas-engine'
import { assessEditOutput, fillTransparentForEdit, type EditOutputIssue } from './studio-image-composite'

const SIZE = 1024

export function needsGenerationTiles(rect: Rect, cutout: boolean): boolean {
  const tiles = tileRange(rect)
  return (cutout && Math.max(rect.width, rect.height) > MAX_RASTER_SIDE) || rect.width * rect.height > 32_000_000
    || (tiles.right - tiles.left + 1) * (tiles.bottom - tiles.top + 1) > 128
}

export function drawGeneration(ctx: CanvasRenderingContext2D, image: HTMLImageElement, frame: Rect, target: Rect) {
  const scale = Math.min(image.naturalWidth / frame.width, image.naturalHeight / frame.height)
  const sx = (image.naturalWidth - frame.width * scale) / 2 + (target.x - frame.x) * scale
  const sy = (image.naturalHeight - frame.height * scale) / 2 + (target.y - frame.y) * scale
  ctx.drawImage(image, sx, sy, target.width * scale, target.height * scale, 0, 0, ctx.canvas.width, ctx.canvas.height)
}

function canvas(width: number, height: number) {
  const result = document.createElement('canvas')
  result.width = width
  result.height = height
  return result
}

type Request = Parameters<Window['electronAPI']['generateStudioImage']>[0]

// Each candidate has its own whole-scene guide, so a prompt for one subject
// is not independently interpreted as a new subject in every tile.
export async function generateTiledCandidate(target: Rect, guide: HTMLImageElement | null, guideFrame: Rect,
  mode: string, layers: CanvasLayer[], globalMask: HTMLCanvasElement | null, request: Request, onProgress: (current: number, total: number) => void) {
  const cols = Math.ceil(target.width / 3072), rows = Math.ceil(target.height / 3072)
  const scale = Math.min(1, 896 / Math.max(target.width / cols, target.height / rows))
  const mosaic = canvas(Math.max(1, Math.round(target.width * scale)), Math.max(1, Math.round(target.height * scale)))
  const dest = mosaic.getContext('2d')!
  let channelGroup = request.channelGroup
  let issue: EditOutputIssue | null = null
  // Shared integer mosaic boundaries keep odd-sized and negative-origin selections aligned.
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    onProgress(row * cols + col + 1, rows * cols)
    const coreX = Math.round(col * mosaic.width / cols), coreY = Math.round(row * mosaic.height / rows)
    const x = Math.max(0, coreX - 32), y = Math.max(0, coreY - 32)
    const right = Math.min(mosaic.width, Math.round((col + 1) * mosaic.width / cols) + 32)
    const bottom = Math.min(mosaic.height, Math.round((row + 1) * mosaic.height / rows) + 32)
    const w = right - x, h = bottom - y
    const rect = { x: target.x + x * target.width / mosaic.width, y: target.y + y * target.height / mosaic.height,
      width: w * target.width / mosaic.width, height: h * target.height / mosaic.height }
    const side = Math.max(rect.width, rect.height)
    const frame = { x: rect.x + (rect.width - side) / 2, y: rect.y + (rect.height - side) / 2, width: side, height: side }
    const source = mode === 'generate' ? canvas(SIZE, SIZE) : rasterizeRegion(layers, frame, SIZE, SIZE)
    const ctx = source.getContext('2d')!
    const mask = canvas(SIZE, SIZE), mctx = mask.getContext('2d')!
    mctx.fillStyle = '#fff'; mctx.fillRect(0, 0, SIZE, SIZE)
    if (globalMask) {
      mctx.clearRect((guideFrame.x - frame.x) * SIZE / side, (guideFrame.y - frame.y) * SIZE / side,
        guideFrame.width * SIZE / side, guideFrame.height * SIZE / side)
      mctx.drawImage(globalMask, (guideFrame.x - frame.x) * SIZE / side, (guideFrame.y - frame.y) * SIZE / side,
        guideFrame.width * SIZE / side, guideFrame.height * SIZE / side)
    }
    if (guide) {
      ctx.globalCompositeOperation = 'destination-over'
      drawGeneration(ctx, guide, guideFrame, frame)
      ctx.globalCompositeOperation = 'source-over'
    }
    const sourcePixels = ctx.getImageData(0, 0, SIZE, SIZE)
    if (globalMask) { fillTransparentForEdit(sourcePixels); ctx.putImageData(sourcePixels, 0, 0) }
    const result = await window.electronAPI.generateStudioImage({ ...request, channelGroup, count: 1, size: '1024x1024',
      prompt: mode === 'generate' ? `Render this crop in detail, preserving its composition and scale. ${request.prompt}`.slice(0, 4000) : request.prompt,
      imageBase64: source.toDataURL('image/png').split(',')[1],
      maskBase64: globalMask ? mask.toDataURL('image/png').split(',')[1] : undefined })
    channelGroup = result.channelGroup ?? channelGroup
    const output = result.images?.[0] ?? result
    const image = new Image(); image.src = `data:${output.mimeType};base64,${output.imageBase64}`; await image.decode()
    if (globalMask) {
      ctx.clearRect(0, 0, SIZE, SIZE)
      drawGeneration(ctx, image, frame, frame)
      issue ??= assessEditOutput(ctx.getImageData(0, 0, SIZE, SIZE), sourcePixels, mctx.getImageData(0, 0, SIZE, SIZE))
    }
    const patch = canvas(w, h), pctx = patch.getContext('2d')!
    drawGeneration(pctx, image, frame, rect)
    const incoming = pctx.getImageData(0, 0, w, h), previous = dest.getImageData(x, y, w, h)
    // Cross-fade premultiplied colors, including partially transparent cutouts.
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      const weight = Math.min(1, col ? (px + 0.5) / 64 : 1, row ? (py + 0.5) / 64 : 1)
      if (weight === 1) continue
      const i = (py * w + px) * 4
      const a = incoming.data[i + 3] * weight, b = previous.data[i + 3] * (1 - weight)
      for (let c = 0; c < 3; c++) incoming.data[i + c] = a + b ? (incoming.data[i + c] * a + previous.data[i + c] * b) / (a + b) : 0
      incoming.data[i + 3] = a + b
    }
    dest.putImageData(incoming, x, y)
  }
  const blob = await new Promise<Blob>((resolve, reject) => mosaic.toBlob(value => value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png'))
  return { blob, width: mosaic.width, height: mosaic.height, issue, channelGroup }
}

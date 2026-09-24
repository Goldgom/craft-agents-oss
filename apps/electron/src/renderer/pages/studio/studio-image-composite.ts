/** Blend in premultiplied color space so transparent edges do not develop dark halos. */
function blendPixel(result: Uint8ClampedArray, reference: Uint8ClampedArray, index: number, weight: number): void {
  if (weight <= 0) {
    for (let channel = 0; channel < 4; channel++) result[index + channel] = reference[index + channel]
    return
  }
  if (weight >= 1) return
  const oldAlpha = reference[index + 3] / 255
  const newAlpha = result[index + 3] / 255
  const alpha = oldAlpha * (1 - weight) + newAlpha * weight
  for (let channel = 0; channel < 3; channel++) {
    const premultiplied = reference[index + channel] * oldAlpha * (1 - weight)
      + result[index + channel] * newAlpha * weight
    result[index + channel] = alpha ? Math.round(premultiplied / alpha) : 0
  }
  result[index + 3] = Math.round(alpha * 255)
}

/** Image edit providers may flatten transparent input against black. Give the mask
 * an opaque source image with a background color sampled from the artwork edge. */
export function fillTransparentForEdit(image: ImageData): [number, number, number] {
  const { data, width, height } = image
  const counts = new Uint32Array(4096)
  const sums = new Uint32Array(4096 * 3)
  const collect = (edgeOnly: boolean) => {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      if (data[offset + 3] < 240) continue
      if (edgeOnly && !(
        (x > 0 && data[offset - 1] < 128)
        || (x + 1 < width && data[offset + 7] < 128)
        || (y > 0 && data[offset - width * 4 + 3] < 128)
        || (y + 1 < height && data[offset + width * 4 + 3] < 128)
      )) continue
      const bin = (data[offset] >> 4) << 8 | (data[offset + 1] >> 4) << 4 | data[offset + 2] >> 4
      counts[bin]++
      for (let channel = 0; channel < 3; channel++) sums[bin * 3 + channel] += data[offset + channel]
    }
  }
  collect(true)
  if (!counts.some(Boolean)) collect(false)
  let dominant = 0
  for (let bin = 1; bin < counts.length; bin++) if (counts[bin] > counts[dominant]) dominant = bin
  const background: [number, number, number] = counts[dominant]
    ? [0, 1, 2].map(channel => Math.round(sums[dominant * 3 + channel] / counts[dominant])) as [number, number, number]
    : [255, 255, 255]
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3] / 255
    if (alpha >= 1) continue
    for (let channel = 0; channel < 3; channel++) {
      data[offset + channel] = Math.round(data[offset + channel] * alpha + background[channel] * (1 - alpha))
    }
    data[offset + 3] = 255
  }
  return background
}

export type EditOutputIssue = 'ignored-mask' | 'black-fill'

/** Measure spatial reference coverage, including sparse line art on transparency. */
export function referenceCoverage(image: ImageData, cellSize = 16): number {
  const columns = Math.ceil(image.width / cellSize)
  const rows = Math.ceil(image.height / cellSize)
  let occupied = 0
  for (let cellY = 0; cellY < rows; cellY++) for (let cellX = 0; cellX < columns; cellX++) {
    let found = false
    const endY = Math.min(image.height, (cellY + 1) * cellSize)
    const endX = Math.min(image.width, (cellX + 1) * cellSize)
    for (let y = cellY * cellSize; y < endY && !found; y++) for (let x = cellX * cellSize; x < endX; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] >= 128) { found = true; break }
    }
    if (found) occupied++
  }
  return occupied / (columns * rows)
}

/** Reject returned images that do not preserve the reference or turn a light
 * empty canvas into a solid black block. The original result remains in history. */
export function assessEditOutput(result: ImageData, source: ImageData, mask: ImageData): EditOutputIssue | null {
  if (result.width !== source.width || result.height !== source.height
    || result.width !== mask.width || result.height !== mask.height) throw new Error('Edit frames must match')
  const step = Math.max(1, Math.ceil(Math.max(result.width, result.height) / 128))
  let preservedCount = 0; let difference = 0; let editedCount = 0; let blackCount = 0
  let inputBrightness = 0
  for (let y = 0; y < result.height; y += step) for (let x = 0; x < result.width; x += step) {
    const offset = (y * result.width + x) * 4
    if (mask.data[offset + 3] >= 250) {
      preservedCount++
      for (let channel = 0; channel < 3; channel++) {
        difference += Math.abs(result.data[offset + channel] - source.data[offset + channel])
      }
    } else if (mask.data[offset + 3] < 10) {
      editedCount++
      inputBrightness += (source.data[offset] + source.data[offset + 1] + source.data[offset + 2]) / 3
      if (result.data[offset] < 8 && result.data[offset + 1] < 8 && result.data[offset + 2] < 8
        && result.data[offset + 3] > 240) blackCount++
    }
  }
  if (editedCount > 100 && inputBrightness / editedCount > 80 && blackCount / editedCount > 0.8) return 'black-fill'
  if (preservedCount > 100 && difference / (preservedCount * 3) > 45) return 'ignored-mask'
  return null
}

/** Replace the selected frame while retaining its exact boundary pixels. */
export function composeInpaint(result: ImageData, reference: ImageData, feather: number): void {
  const { width, height } = result
  if (reference.width !== width || reference.height !== height) throw new Error('Inpaint frames must match')
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4
    const distance = Math.min(x, y, width - 1 - x, height - 1 - y)
    const weight = reference.data[index + 3] === 0 ? 1 : Math.min(1, distance / feather)
    blendPixel(result.data, reference.data, index, weight)
  }
}

/** Keep original artwork and replace blank pixels, blending only across their seam. */
export function composeOutpaint(result: ImageData, reference: ImageData, feather: number): void {
  const { width, height } = result
  if (reference.width !== width || reference.height !== height) throw new Error('Outpaint frames must match')
  const length = width * height
  const distance = new Uint16Array(length)
  distance.fill(0xffff)
  for (let index = 0; index < length; index++) if (reference.data[index * 4 + 3] === 0) distance[index] = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x
    if (x) distance[index] = Math.min(distance[index], distance[index - 1] + 1)
    if (y) distance[index] = Math.min(distance[index], distance[index - width] + 1)
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const index = y * width + x
    if (x + 1 < width) distance[index] = Math.min(distance[index], distance[index + 1] + 1)
    if (y + 1 < height) distance[index] = Math.min(distance[index], distance[index + width] + 1)
  }
  for (let index = 0; index < length; index++) {
    const pixel = index * 4
    const weight = reference.data[pixel + 3] === 0 ? 1 : Math.max(0, 1 - distance[index] / feather)
    blendPixel(result.data, reference.data, pixel, weight)
  }
}

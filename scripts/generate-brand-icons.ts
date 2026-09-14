import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import sharp from 'sharp'

const ROOT = resolve(import.meta.dir, '..')
const TOKENBIRD_SOURCE = join(ROOT, 'docs/branding/tokenbird-icon-transparent.png')
const TOKENNEST_SOURCE = join(ROOT, 'docs/branding/tokennest-logo-transparent.png')

async function writeOutput(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
}

async function squareIcon(cutout: Buffer, size: number, paddingRatio = 0.055): Promise<Buffer> {
  const inner = Math.round(size * (1 - paddingRatio * 2))
  const trimmed = await sharp(cutout)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
    .png({ compressionLevel: 9 })
    .toBuffer()
  const subject = await sharp(trimmed)
    .resize({
      width: inner,
      height: inner,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toBuffer()

  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: subject, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

function buildIco(images: Array<{ size: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length

  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16
    header[entry] = size === 256 ? 0 : size
    header[entry + 1] = size === 256 ? 0 : size
    header[entry + 2] = 0
    header[entry + 3] = 0
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(data.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })

  return Buffer.concat([header, ...images.map(image => image.data)])
}

function buildIcns(images: Array<{ type: string; data: Buffer }>): Buffer {
  const chunks = images.map(({ type, data }) => {
    const chunk = Buffer.alloc(8 + data.length)
    chunk.write(type, 0, 4, 'ascii')
    chunk.writeUInt32BE(chunk.length, 4)
    data.copy(chunk, 8)
    return chunk
  })
  const output = Buffer.alloc(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  output.write('icns', 0, 4, 'ascii')
  output.writeUInt32BE(output.length, 4)
  let offset = 8
  for (const chunk of chunks) {
    chunk.copy(output, offset)
    offset += chunk.length
  }
  return output
}

async function main(): Promise<void> {
  const [tokenBirdCutout, tokenNestCutout] = await Promise.all([
    readFile(TOKENBIRD_SOURCE),
    readFile(TOKENNEST_SOURCE),
  ])

  const tokenBird1024 = await squareIcon(tokenBirdCutout, 1024)
  const tokenNest512 = await squareIcon(tokenNestCutout, 512)
  const iconSizes = [16, 24, 32, 48, 64, 128, 256]
  const icoImages = await Promise.all(iconSizes.map(async size => ({
    size,
    data: await sharp(tokenBird1024).resize(size, size).png({ compressionLevel: 9 }).toBuffer(),
  })))
  const icnsSpecs = [
    ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128],
    ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ] as const
  const icnsImages = await Promise.all(icnsSpecs.map(async ([type, size]) => ({
    type,
    data: await sharp(tokenBird1024).resize(size, size).png({ compressionLevel: 9 }).toBuffer(),
  })))

  await Promise.all([
    writeOutput(join(ROOT, 'apps/electron/resources/icon.png'), await sharp(tokenBird1024).resize(512, 512).png({ compressionLevel: 9 }).toBuffer()),
    writeOutput(join(ROOT, 'apps/electron/resources/icon.ico'), buildIco(icoImages)),
    writeOutput(join(ROOT, 'apps/electron/resources/icon.icns'), buildIcns(icnsImages)),
    writeOutput(join(ROOT, 'apps/electron/resources/icon.icon/Assets/icon.png'), tokenBird1024),
    writeOutput(join(ROOT, 'apps/electron/src/renderer/assets/branding/tokenbird.png'), await sharp(tokenBird1024).resize(512, 512).png({ compressionLevel: 9 }).toBuffer()),
    writeOutput(join(ROOT, 'apps/electron/src/renderer/assets/provider-icons/tokennest.png'), tokenNest512),
    writeOutput(join(ROOT, 'apps/android/app/src/main/res/drawable/ic_launcher.png'), await sharp(tokenBird1024).resize(512, 512).png({ compressionLevel: 9 }).toBuffer()),
    writeOutput(join(ROOT, 'apps/webui/src/public/icon-512.png'), await sharp(tokenBird1024).resize(512, 512).png({ compressionLevel: 9 }).toBuffer()),
    writeOutput(join(ROOT, 'apps/webui/src/public/icon-192.png'), await sharp(tokenBird1024).resize(192, 192).png({ compressionLevel: 9 }).toBuffer()),
    writeOutput(join(ROOT, 'apps/webui/src/public/apple-touch-icon.png'), await sharp(tokenBird1024).resize(180, 180).png({ compressionLevel: 9 }).toBuffer()),
    writeOutput(join(ROOT, 'apps/webui/src/public/favicon.ico'), buildIco(icoImages.filter(image => [16, 32, 48].includes(image.size)))),
  ])

  console.log('Generated transparent TokenBird application icons and TokenNest provider logo.')
}

await main()

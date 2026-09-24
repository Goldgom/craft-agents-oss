import { expect, it } from 'bun:test'
import sharp from 'sharp'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { jpegToPdf } from './studio-pdf'

it('creates a readable PDF page containing the exported image', async () => {
  const jpeg = await sharp({ create: { width: 240, height: 120, channels: 3, background: '#dae8fc' } }).jpeg().toBuffer()
  const blob = jpegToPdf(jpeg, 240, 120)
  const document = await getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise
  expect(document.numPages).toBe(1)
  const page = await document.getPage(1)
  expect(page.getViewport({ scale: 1 }).width).toBe(240)
  expect(page.getViewport({ scale: 1 }).height).toBe(120)
  expect((await page.getOperatorList()).fnArray.length).toBeGreaterThan(0)
})

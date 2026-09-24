/** Wrap a browser-produced JPEG in a single-page PDF without another runtime dependency. */
export function jpegToPdf(jpeg: Uint8Array, imageWidth: number, imageHeight: number): Blob {
  if (!jpeg.length || imageWidth <= 0 || imageHeight <= 0) throw new Error('Invalid PDF image')
  const pageScale = Math.min(1, 14400 / Math.max(imageWidth, imageHeight))
  const width = Math.round(imageWidth * pageScale * 100) / 100
  const height = Math.round(imageHeight * pageScale * 100) / 100
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let length = 0
  const offsets = [0]
  const append = (value: string | Uint8Array) => {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value
    chunks.push(bytes)
    length += bytes.length
  }
  const object = (number: number, body: () => void) => {
    offsets[number] = length
    append(`${number} 0 obj\n`)
    body()
    append('\nendobj\n')
  }
  append('%PDF-1.4\n')
  object(1, () => append('<< /Type /Catalog /Pages 2 0 R >>'))
  object(2, () => append('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'))
  object(3, () => append(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`))
  object(4, () => {
    append(`<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`)
    append(jpeg)
    append('\nendstream')
  })
  const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q\n`
  object(5, () => append(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`))
  const xref = length
  append('xref\n0 6\n0000000000 65535 f \n')
  for (let i = 1; i <= 5; i++) append(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  append(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' })
}

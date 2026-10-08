/** File metadata shared by desktop and browser canvas export bridges. */
export function canvasExportInfo(input: Record<string, unknown>): { mime: string; extension: string; extensions: string[] } {
  if (input.action === 'save_project') return { mime: 'application/json', extension: 'tbcanvas', extensions: ['.tbcanvas'] }
  if (input.action !== 'export_image') return { mime: 'image/png', extension: 'png', extensions: ['.png'] }
  const format = input.format ?? 'png'
  if (format === 'jpeg') return { mime: 'image/jpeg', extension: 'jpg', extensions: ['.jpg','.jpeg'] }
  if (format === 'png' || format === 'webp') return { mime: `image/${format}`, extension: format, extensions: [`.${format}`] }
  throw new Error('Unsupported image export format')
}

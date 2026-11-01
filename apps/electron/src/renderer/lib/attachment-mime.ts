// Mobile document providers may supply an empty or generic File.type.
export function attachmentMimeType(file: Pick<File, 'name' | 'type'>): string {
  if (file.type && file.type !== 'application/octet-stream') return file.type
  const extension = file.name.split('.').pop()?.toLowerCase()
  const images: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', svg: 'image/svg+xml',
  }
  return extension && Object.hasOwn(images, extension)
    ? images[extension]!
    : file.type || 'application/octet-stream'
}

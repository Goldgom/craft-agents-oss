import type { FileAttachment } from '../../../electron/src/shared/types'
import { invokeAndroidNative } from '../../../electron/src/shared/android-native'

// These handles denote files explicitly selected on this device, never server paths.
const pickedFiles = new Map<string, File>()
export function getPickedFile(path: string): File | undefined { return pickedFiles.get(path) }

export function webFilePicker(accept = ''): Promise<string[]> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'; input.multiple = true; input.accept = accept
    input.style.display = 'none'; document.body.appendChild(input)
    let settled = false
    const finish = (files: File[]) => {
      if (settled) return
      settled = true
      window.removeEventListener('craft-agent:file-picker-cancel', cancel)
      input.remove()
      const paths = files.map(file => {
        const path = `web-file://${crypto.randomUUID()}/${encodeURIComponent(file.name)}`
        pickedFiles.set(path, file)
        return path
      })
      // Bound memory retained for backup/file picker handles.
      while (pickedFiles.size > 32) pickedFiles.delete(pickedFiles.keys().next().value!)
      resolve(paths)
    }
    const cancel = () => finish([])
    input.onchange = () => finish(Array.from(input.files ?? []))
    input.oncancel = cancel
    window.addEventListener('craft-agent:file-picker-cancel', cancel)
    input.click()
  })
}

export async function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(blob)
  })
}

export async function pickedAttachment(path: string): Promise<FileAttachment | null> {
  const file = getPickedFile(path)
  if (!file) return null
  const mimeType = file.type || 'application/octet-stream'
  const type = mimeType.startsWith('image/') ? 'image' : mimeType === 'application/pdf' ? 'pdf'
    : mimeType.startsWith('audio/') ? 'audio' : mimeType.startsWith('text/') || /\.(md|json|csv|yaml|yml|ts|js|py)$/i.test(file.name) ? 'text' : 'unknown'
  return { name: file.name, path, mimeType, type, size: file.size,
    ...(type === 'text' ? { text: await file.text() } : { base64: await blobBase64(file) }) }
}

export async function saveBlob(blob: Blob, name: string): Promise<{ canceled?: boolean; path?: string }> {
  const bridge = window.CraftAgentAndroid
  if (bridge?.saveFile) {
    if (blob.size > 64 * 1024 * 1024) throw new Error('文件超过 64 MB，请通过服务器文件管理下载')
    const base64 = await blobBase64(blob)
    return invokeAndroidNative('craft-agent:android-file-result', id => bridge.saveFile!(id, name, blob.type || 'application/octet-stream', base64), 10 * 60_000)
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a'); link.href = url; link.download = name
  document.body.appendChild(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return { path: name }
}

/** Capture existing renderer downloads (canvas, draw.io, page exports) in Android. */
export function installAndroidDownloads(): () => void {
  const onClick = (event: MouseEvent) => {
    const link = (event.target as Element | null)?.closest?.('a[download]') as HTMLAnchorElement | null
    if (!link || !window.CraftAgentAndroid?.saveFile) return
    if (!link.href.startsWith('blob:') && !link.href.startsWith('data:')) return
    event.preventDefault()
    event.stopImmediatePropagation()
    void fetch(link.href).then(response => response.blob()).then(blob => saveBlob(blob, link.download || 'TokenBird-export'))
      .catch(error => window.dispatchEvent(new CustomEvent('craft-agent:file-error', { detail: String(error) })))
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}

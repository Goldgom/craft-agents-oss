import { BrowserWindow, dialog, type WebContents } from 'electron'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import sharp from 'sharp'

import { buildChatMarkdown, buildChatHtml, buildChatDocx as buildDocx } from '../shared/chat-export-format'
import type { ChatExportRequest, ChatExportResult, ChatExportFormat } from '../shared/chat-export-format'
export { buildChatMarkdown, buildChatHtml, renderMarkdownHtml } from '../shared/chat-export-format'
export type { ChatExportRequest, ChatExportResult, ChatExportFormat, ChatExportMode, ChatExportMessage } from '../shared/chat-export-format'
export function buildChatDocx(request: ChatExportRequest): Buffer { return Buffer.from(buildDocx(request)) }

const FORMAT_OPTIONS: Record<ChatExportFormat, { extension: string; filterName: string }> = {
  markdown: { extension: 'md', filterName: 'Markdown' },
  docx: { extension: 'docx', filterName: 'Word' },
  pdf: { extension: 'pdf', filterName: 'PDF' },
  png: { extension: 'png', filterName: 'PNG' },
}

function sanitizeFileName(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim()
  return (sanitized || 'TokenBird-chat').slice(0, 120)
}

async function loadExportWindow(html: string): Promise<{ win: BrowserWindow; cleanup: () => Promise<void> }> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tokenbird-chat-export-'))
  const htmlPath = join(tempRoot, 'index.html')
  await writeFile(htmlPath, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  await win.loadFile(htmlPath)
  return {
    win,
    cleanup: async () => {
      if (!win.isDestroyed()) win.destroy()
      await rm(tempRoot, { recursive: true, force: true })
    },
  }
}

export async function renderChatPdf(request: ChatExportRequest): Promise<Buffer> {
  const html = buildChatHtml(request)
  const { win, cleanup } = await loadExportWindow(html)
  try {
    return await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    })
  } finally {
    await cleanup()
  }
}

async function pageHeight(contents: WebContents): Promise<number> {
  return await contents.executeJavaScript('Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))') as number
}

export async function renderChatPng(request: ChatExportRequest): Promise<Buffer> {
  const html = buildChatHtml(request)
  const { win, cleanup } = await loadExportWindow(html)
  try {
    const height = Math.max(1, await pageHeight(win.webContents))
    const width = 1100
    const tileHeight = 12000
    const tiles: Array<{ input: Buffer; top: number; left: number }> = []

    for (let y = 0; y < height; y += tileHeight) {
      const currentHeight = Math.min(tileHeight, height - y)
      const image = await win.webContents.capturePage(
        { x: 0, y, width, height: currentHeight },
        { stayHidden: true, stayAwake: true },
      )
      if (image.isEmpty()) throw new Error('Failed to render conversation image')
      tiles.push({ input: image.toPNG(), top: y, left: 0 })
    }

    if (tiles.length === 1) return tiles[0].input
    return await sharp({
      create: { width, height, channels: 4, background: '#ffffff' },
    }).composite(tiles).png({ compressionLevel: 9 }).toBuffer()
  } finally {
    await cleanup()
  }
}

export async function exportChatTranscript(owner: BrowserWindow | null, request: ChatExportRequest): Promise<ChatExportResult> {
  const option = FORMAT_OPTIONS[request.format]
  if (!option || !Array.isArray(request.messages)) return { success: false, error: 'Invalid export request' }
  if (request.mode === 'full' && request.format !== 'pdf') return { success: false, error: 'Full export is only available as PDF' }

  const defaultPath = `${sanitizeFileName(request.title)}.${option.extension}`
  const result = owner
    ? await dialog.showSaveDialog(owner, { title: 'Export conversation', defaultPath, filters: [{ name: option.filterName, extensions: [option.extension] }] })
    : await dialog.showSaveDialog({ title: 'Export conversation', defaultPath, filters: [{ name: option.filterName, extensions: [option.extension] }] })
  if (result.canceled || !result.filePath) return { success: false, canceled: true }

  try {
    let data: string | Buffer
    if (request.format === 'markdown') data = buildChatMarkdown(request)
    else if (request.format === 'docx') data = buildChatDocx(request)
    else {
      data = request.format === 'pdf' ? await renderChatPdf(request) : await renderChatPng(request)
    }
    await writeFile(result.filePath, data)
    return { success: true, path: result.filePath }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function exportedFileName(path: string): string {
  return basename(path)
}

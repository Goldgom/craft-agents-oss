import { BrowserWindow, dialog, type WebContents } from 'electron'
import { Marked, Renderer } from 'marked'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import sharp from 'sharp'

export type ChatExportFormat = 'markdown' | 'docx' | 'pdf' | 'png'
export type ChatExportMode = 'chat' | 'full'

export interface ChatExportMessage {
  role: 'user' | 'assistant' | 'tool' | 'error' | 'status' | 'info' | 'warning' | 'plan' | 'auth-request'
  content: string
  timestamp?: number
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: string
  attachments?: Array<{ name: string }>
  hidden?: boolean
}

export interface ChatExportRequest {
  format: ChatExportFormat
  mode?: ChatExportMode
  title: string
  exportedAt: string
  messages: ChatExportMessage[]
  labels: {
    exportedAt: string
    attachments: string
    toolInput: string
    toolResult: string
    roles: Record<ChatExportMessage['role'], string>
  }
}

export interface ChatExportResult {
  success: boolean
  canceled?: boolean
  path?: string
  error?: string
}

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

function escapeMarkdown(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([`*_{}[\]()#+.!>|-])/g, '\\$1')
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function escapeHtml(value: string): string {
  return escapeXml(value)
}

const markdownRenderer = new Renderer()
markdownRenderer.html = ({ text }) => escapeHtml(text)
const markdownParser = new Marked({
  breaks: true,
  gfm: true,
  renderer: markdownRenderer,
})

export function renderMarkdownHtml(value: string): string {
  const rendered = markdownParser.parse(value, { async: false })
  return typeof rendered === 'string' ? rendered : escapeHtml(value)
}

function timestampText(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return ''
  try {
    return new Date(timestamp).toLocaleString()
  } catch {
    return ''
  }
}

function visibleMessages(request: ChatExportRequest): ChatExportMessage[] {
  return request.messages.filter(message => {
    if (request.mode !== 'full' && (message.hidden || (message.role !== 'user' && message.role !== 'assistant'))) return false
    return Boolean(message.content?.trim() || message.toolResult?.trim() || message.toolInput || message.attachments?.length)
  })
}

function includeToolDetails(request: ChatExportRequest): boolean {
  return request.mode === 'full'
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function buildChatMarkdown(request: ChatExportRequest): string {
  const lines = [`# ${escapeMarkdown(request.title)}`, '', `${request.labels.exportedAt}: ${request.exportedAt}`, '']

  for (const message of visibleMessages(request)) {
    const role = message.role === 'tool' && message.toolName
      ? `${request.labels.roles.tool}: ${message.toolName}`
      : request.labels.roles[message.role]
    const time = timestampText(message.timestamp)
    lines.push(`## ${escapeMarkdown(role)}${time ? ` · ${escapeMarkdown(time)}` : ''}`, '')

    if (message.content?.trim()) lines.push(message.content.trim(), '')
    if (message.attachments?.length) {
      lines.push(`**${escapeMarkdown(request.labels.attachments)}:** ${message.attachments.map(item => escapeMarkdown(item.name)).join(', ')}`, '')
    }
    if (includeToolDetails(request) && message.toolInput) {
      lines.push(`**${escapeMarkdown(request.labels.toolInput)}**`, '', '```json', safeJson(message.toolInput), '```', '')
    }
    if (includeToolDetails(request) && message.toolResult?.trim()) {
      lines.push(`**${escapeMarkdown(request.labels.toolResult)}**`, '', '```text', message.toolResult.trim(), '```', '')
    }
  }

  return `${lines.join('\n').trimEnd()}\n`
}

export function buildChatHtml(request: ChatExportRequest): string {
  const messages = visibleMessages(request).map(message => {
    const role = message.role === 'tool' && message.toolName
      ? `${request.labels.roles.tool}: ${message.toolName}`
      : request.labels.roles[message.role]
    const details: string[] = []
    if (message.content?.trim()) details.push(`<div class="content">${renderMarkdownHtml(message.content.trim())}</div>`)
    if (message.attachments?.length) {
      details.push(`<div class="meta"><strong>${escapeHtml(request.labels.attachments)}:</strong> ${message.attachments.map(item => escapeHtml(item.name)).join(', ')}</div>`)
    }
    if (includeToolDetails(request) && message.toolInput) {
      details.push(`<div class="meta"><strong>${escapeHtml(request.labels.toolInput)}</strong></div><pre>${escapeHtml(safeJson(message.toolInput))}</pre>`)
    }
    if (includeToolDetails(request) && message.toolResult?.trim()) {
      details.push(`<div class="meta"><strong>${escapeHtml(request.labels.toolResult)}</strong></div><pre>${escapeHtml(message.toolResult.trim())}</pre>`)
    }
    return `<section class="message ${message.role}"><header><strong>${escapeHtml(role)}</strong><time>${escapeHtml(timestampText(message.timestamp))}</time></header>${details.join('')}</section>`
  }).join('')

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 16mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #172033; }
    body { font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; padding: 48px; }
    main { width: 100%; max-width: 920px; margin: 0 auto; }
    h1 { margin: 0 0 6px; font-size: 28px; line-height: 1.3; overflow-wrap: anywhere; }
    .exported { color: #6b7280; margin-bottom: 28px; font-size: 13px; }
    .message { margin: 0 0 18px; padding: 16px 18px; border: 1px solid #e5e7eb; border-radius: 12px; break-inside: avoid; background: #fff; }
    .message.user { background: #eff6ff; border-color: #bfdbfe; }
    .message.error, .message.warning { background: #fff7ed; border-color: #fed7aa; }
    .message.tool { background: #f8fafc; }
    header { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 9px; color: #334155; }
    time { color: #94a3b8; font-size: 12px; white-space: nowrap; }
    .content { overflow-wrap: anywhere; word-break: break-word; }
    .content > :first-child { margin-top: 0; }
    .content > :last-child { margin-bottom: 0; }
    .content h1, .content h2, .content h3, .content h4 { margin: 1em 0 0.45em; line-height: 1.3; }
    .content h1 { font-size: 1.55em; }
    .content h2 { font-size: 1.35em; }
    .content h3 { font-size: 1.18em; }
    .content p, .content ul, .content ol, .content blockquote, .content table { margin: 0.65em 0; }
    .content ul, .content ol { padding-left: 1.6em; }
    .content blockquote { padding: 0.1em 0 0.1em 1em; border-left: 3px solid #cbd5e1; color: #475569; }
    .content table { width: 100%; border-collapse: collapse; }
    .content th, .content td { padding: 6px 8px; border: 1px solid #cbd5e1; text-align: left; }
    .content code { padding: 0.12em 0.35em; background: #e2e8f0; border-radius: 4px; font: 0.88em Consolas, "SFMono-Regular", monospace; }
    .content pre, pre { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .content pre code { padding: 0; background: transparent; color: inherit; }
    .meta { margin-top: 10px; color: #475569; font-size: 13px; }
    pre { margin: 8px 0 0; padding: 12px; background: #0f172a; color: #e2e8f0; border-radius: 8px; font: 12px/1.55 Consolas, "SFMono-Regular", monospace; }
  </style></head><body><main><h1>${escapeHtml(request.title)}</h1><div class="exported">${escapeHtml(request.labels.exportedAt)}: ${escapeHtml(request.exportedAt)}</div>${messages}</main></body></html>`
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zipStored(files: Array<{ name: string; data: string }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const data = Buffer.from(file.data, 'utf8')
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + data.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, ...centralParts, end])
}

function wordParagraph(text: string, style?: 'Title' | 'Heading1'): string {
  const properties = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const runs = lines.map((line, index) => `${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${escapeXml(line)}</w:t>`).join('')
  return `<w:p>${properties}<w:r>${runs}</w:r></w:p>`
}

export function buildChatDocx(request: ChatExportRequest): Buffer {
  const body: string[] = [wordParagraph(request.title, 'Title'), wordParagraph(`${request.labels.exportedAt}: ${request.exportedAt}`)]
  for (const message of visibleMessages(request)) {
    const role = message.role === 'tool' && message.toolName
      ? `${request.labels.roles.tool}: ${message.toolName}`
      : request.labels.roles[message.role]
    const time = timestampText(message.timestamp)
    body.push(wordParagraph(`${role}${time ? ` · ${time}` : ''}`, 'Heading1'))
    if (message.content?.trim()) body.push(wordParagraph(message.content.trim()))
    if (message.attachments?.length) body.push(wordParagraph(`${request.labels.attachments}: ${message.attachments.map(item => item.name).join(', ')}`))
    if (includeToolDetails(request) && message.toolInput) body.push(wordParagraph(`${request.labels.toolInput}\n${safeJson(message.toolInput)}`))
    if (includeToolDetails(request) && message.toolResult?.trim()) body.push(wordParagraph(`${request.labels.toolResult}\n${message.toolResult.trim()}`))
  }
  body.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>')

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}</w:body></w:document>`
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Aptos" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style></w:styles>`

  return zipStored([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: stylesXml },
  ])
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

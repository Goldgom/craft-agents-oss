import { describe, expect, mock, test } from 'bun:test'
import sharp from 'sharp'

const captureRects: Array<{ x: number; y: number; width: number; height: number }> = []
const tallExportTile = await sharp({
  create: { width: 1100, height: 12000, channels: 4, background: '#ffffff' },
}).png().toBuffer()

mock.module('electron', () => ({
  BrowserWindow: class {
    webContents = {
      executeJavaScript: async () => 36000,
      capturePage: async (rect: { x: number; y: number; width: number; height: number }) => {
        captureRects.push(rect)
        return { isEmpty: () => false, toPNG: () => tallExportTile }
      },
    }
    loadFile = async () => {}
    isDestroyed = () => false
    destroy = () => {}
  },
  dialog: {},
}))

const { buildChatDocx, buildChatHtml, buildChatMarkdown, exportChatTranscript, renderChatPng, renderMarkdownHtml } = await import('./chat-export')
type ChatExportRequest = import('./chat-export').ChatExportRequest

const request: ChatExportRequest = {
  format: 'markdown',
  title: '测试会话',
  exportedAt: '2026-09-20 12:00',
  labels: {
    exportedAt: '导出时间',
    attachments: '附件',
    toolInput: '工具输入',
    toolResult: '工具结果',
    roles: {
      user: '用户',
      assistant: '助手',
      tool: '工具',
      error: '错误',
      status: '状态',
      info: '信息',
      warning: '警告',
      plan: '计划',
      'auth-request': '授权请求',
    },
  },
  messages: [
    { role: 'user', content: '请检查项目', attachments: [{ name: '说明.txt' }] },
    { role: 'assistant', content: '## 已经完成\n\n- 第一项\n- 第二项' },
    { role: 'tool', content: '', toolName: 'Read', toolInput: { path: 'a.ts' }, toolResult: 'ok' },
    { role: 'status', content: '处理中' },
    { role: 'assistant', content: 'hidden', hidden: true },
  ],
}

describe('chat export', () => {
  test('standard export contains only user and assistant chat messages', () => {
    const markdown = buildChatMarkdown(request)
    expect(markdown).toContain('# 测试会话')
    expect(markdown).toContain('## 用户')
    expect(markdown).toContain('说明\\.txt')
    expect(markdown).not.toContain('## 工具: Read')
    expect(markdown).not.toContain('"path": "a.ts"')
    expect(markdown).not.toContain('处理中')
    expect(markdown).not.toContain('hidden')
  })

  test('full export includes tool calls and all stored message content', () => {
    const markdown = buildChatMarkdown({ ...request, format: 'pdf', mode: 'full' })
    expect(markdown).toContain('## 工具: Read')
    expect(markdown).toContain('"path": "a.ts"')
    expect(markdown).toContain('处理中')
    expect(markdown).toContain('hidden')
  })

  test('renders markdown for PDF and image HTML while escaping raw HTML', () => {
    const html = buildChatHtml(request)
    expect(html).toContain('<h2>已经完成</h2>')
    expect(html).toContain('<li>第一项</li>')
    expect(renderMarkdownHtml('<script>alert(1)</script>')).toContain('&lt;script&gt;')
    expect(renderMarkdownHtml('<script>alert(1)</script>')).not.toContain('<script>')
  })

  test('rejects full export formats other than PDF', async () => {
    const result = await exportChatTranscript(null, { ...request, format: 'png', mode: 'full' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('only available as PDF')
  })

  test('captures and stitches tall image exports in safe-sized tiles', async () => {
    captureRects.length = 0
    const png = await renderChatPng(request)
    const metadata = await sharp(png).metadata()
    expect(captureRects.map(rect => ({ y: rect.y, height: rect.height }))).toEqual([
      { y: 0, height: 12000 },
      { y: 12000, height: 12000 },
      { y: 24000, height: 12000 },
    ])
    expect(metadata.width).toBe(1100)
    expect(metadata.height).toBe(36000)
  })

  test('builds a valid docx zip container', () => {
    const docx = buildChatDocx({ ...request, format: 'docx' })
    expect(docx.subarray(0, 4).toString('hex')).toBe('504b0304')
    expect(docx.includes(Buffer.from('word/document.xml'))).toBe(true)
    expect(docx.includes(Buffer.from('测试会话'))).toBe(true)
  })
})

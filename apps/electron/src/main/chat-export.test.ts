import { describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  BrowserWindow: class {},
  dialog: {},
}))

const { buildChatDocx, buildChatMarkdown } = await import('./chat-export')
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
    { role: 'assistant', content: '已经完成。' },
    { role: 'tool', content: '', toolName: 'Read', toolInput: { path: 'a.ts' }, toolResult: 'ok' },
    { role: 'status', content: '处理中' },
    { role: 'assistant', content: 'hidden', hidden: true },
  ],
}

describe('chat export', () => {
  test('builds a readable markdown transcript and excludes transient messages', () => {
    const markdown = buildChatMarkdown(request)
    expect(markdown).toContain('# 测试会话')
    expect(markdown).toContain('## 用户')
    expect(markdown).toContain('说明\\.txt')
    expect(markdown).toContain('## 工具: Read')
    expect(markdown).toContain('"path": "a.ts"')
    expect(markdown).not.toContain('处理中')
    expect(markdown).not.toContain('hidden')
  })

  test('builds a valid docx zip container', () => {
    const docx = buildChatDocx({ ...request, format: 'docx' })
    expect(docx.subarray(0, 4).toString('hex')).toBe('504b0304')
    expect(docx.includes(Buffer.from('word/document.xml'))).toBe(true)
    expect(docx.includes(Buffer.from('测试会话'))).toBe(true)
  })
})

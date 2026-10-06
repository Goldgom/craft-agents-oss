import { buildChatMarkdown, buildChatHtml, buildChatDocx, type ChatExportRequest, type ChatExportResult } from '../../../electron/src/shared/chat-export-format'
import { saveBlob } from './browser-files'
import { invokeAndroidNative } from '../../../electron/src/shared/android-native'

export async function exportWebChat(request: ChatExportRequest): Promise<ChatExportResult> {
  try {
    const name = (request.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'TokenBird-chat').slice(0, 120)
    if (request.format === 'pdf' && window.CraftAgentAndroid?.printHtml) {
      window.CraftAgentAndroid.printHtml(name, buildChatHtml(request))
      // Android's print sheet owns completion/cancellation. Do not claim a saved path.
      return { success: true }
    }
    if (request.format === 'png') {
      const bridge = window.CraftAgentAndroid
      if (!bridge?.renderHtmlImage) throw new Error('请在安卓应用中使用对话长图导出')
      const result = await invokeAndroidNative<{ canceled?: boolean; path?: string }>('craft-agent:android-file-result', id => bridge.renderHtmlImage!(id, `${name}.png`, buildChatHtml(request)), 10 * 60_000)
      return { success: !result.canceled, ...result }
    }
    if (request.format === 'pdf') throw new Error('请在安卓应用中使用系统 PDF 导出')
    const blob = request.format === 'docx'
      ? new Blob([buildChatDocx(request) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
      : new Blob([buildChatMarkdown(request)], { type: 'text/markdown' })
    const result = await saveBlob(blob, `${name}.${request.format === 'docx' ? 'docx' : 'md'}`)
    return { success: !result.canceled, ...result }
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
}

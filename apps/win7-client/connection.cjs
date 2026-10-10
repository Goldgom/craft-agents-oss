'use strict'

function normalizeConnection(input) {
  if (!input || typeof input.serverUrl !== 'string') throw new Error('请输入服务器地址')
  let url
  try { url = new URL(input.serverUrl.trim()) } catch { throw new Error('服务器地址格式不正确') }
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || url.search) {
    throw new Error('请使用不含密码、查询参数或片段的 ws:// 或 wss:// 地址')
  }
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : ''
  if (token.length > 16384 || workspaceId.length > 1024) throw new Error('令牌或工作区 ID 过长')
  return { serverUrl: url.href, token: token || undefined, workspaceId: workspaceId || undefined }
}

module.exports = { normalizeConnection }

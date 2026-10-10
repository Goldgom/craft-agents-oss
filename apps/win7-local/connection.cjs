'use strict'
const fs = require('node:fs')
const path = require('node:path')
function validateProfile(input, hasStoredKey = false) {
  if (!input || typeof input !== 'object') throw new Error('配置无效')
  const api = input.api
  if (!['openai-completions', 'anthropic-messages'].includes(api)) throw new Error('请选择支持的 API 协议')
  let url
  try { url = new URL(String(input.baseUrl).trim()) } catch { throw new Error('API 地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含账户、查询参数或片段')
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (!local && url.protocol !== 'https:') throw new Error('非本机 API 地址必须使用 HTTPS')
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (!model || model.length > 200 || /[\r\n\0]/.test(model)) throw new Error('请输入模型 ID')
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  if (apiKey.length > 8192 || /[\r\n\0]/.test(apiKey)) throw new Error('API Key 无效')
  if (!local && !apiKey && !hasStoredKey) throw new Error('请输入 API Key')
  const workingDirectory = path.resolve(String(input.workingDirectory || ''))
  if (!input.workingDirectory || !fs.statSync(workingDirectory).isDirectory()) throw new Error('工作目录不存在')
  return { api, baseUrl: url.href.replace(/\/+$/, ''), model, apiKey, workingDirectory, local }
}
module.exports = { validateProfile }

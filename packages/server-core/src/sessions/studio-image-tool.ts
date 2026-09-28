import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getLlmConnections, isImageGenerationModelId, type LlmConnection } from '@craft-agent/shared/config'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { getValidTokenNestCredentials } from '@craft-agent/shared/auth'
import { getSessionPath } from '@craft-agent/shared/sessions'
import { generateStudioImage } from '../handlers/rpc/studio'

type ImageOption = { connectionSlug: string; name: string; model: string; channelGroup?: string }

function modelsFor(connection: LlmConnection): ImageOption[] {
  if (connection.oauthProvider === 'tokennest') {
    return (connection.channelGroups ?? []).flatMap(group =>
      (group.models ?? []).filter(isImageGenerationModelId).map(model => ({
        connectionSlug: connection.slug, name: connection.name, model, channelGroup: group.id,
      })))
  }
  if (connection.authType !== 'api_key' && connection.authType !== 'api_key_with_endpoint') return []
  if (connection.piAuthProvider !== 'openai' && connection.customEndpoint?.api !== 'openai-completions') return []
  const configured = (connection.models ?? []).map(item => typeof item === 'string' ? item : item.id)
  const models = configured.filter(isImageGenerationModelId)
  if (!models.length && connection.piAuthProvider === 'openai'
    && (!connection.baseUrl || /^https:\/\/api\.openai\.com\/v1\/?$/i.test(connection.baseUrl))) models.push('gpt-image-1')
  return models.map(model => ({ connectionSlug: connection.slug, name: connection.name, model }))
}

async function availableImageOptions(): Promise<ImageOption[]> {
  const manager = getCredentialManager()
  const options = await Promise.all(getLlmConnections().map(async connection => {
    const models = modelsFor(connection)
    if (!models.length) return []
    try {
      const authenticated = connection.oauthProvider === 'tokennest'
        ? !!(await getValidTokenNestCredentials(connection.slug, manager))?.accessToken
        : !!(await manager.getLlmApiKey(connection.slug))
      return authenticated ? models : []
    } catch {
      return []
    }
  }))
  return options.flat()
}

export async function runStudioImageToolAction(
  workspaceRoot: string,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const options = await availableImageOptions()
  if (args.action === 'list_image_connections') {
    return { available: options.length > 0, options, ...(options.length ? {} : {
      message: '请先配置支持 GPT Image 的绘画连接，或登录具备图片分组权限的 TokenNest。',
    }) }
  }
  if (args.action !== 'generate_image') throw new Error('Unknown image action')
  if (!options.length) throw new Error('请先配置支持 GPT Image 的绘画连接，或登录具备图片分组权限的 TokenNest。')
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt || prompt.length > 4000) throw new Error('prompt is required (maximum 4000 characters)')
  const requested = options.filter(option =>
    (typeof args.connectionSlug !== 'string' || option.connectionSlug === args.connectionSlug)
    && (typeof args.model !== 'string' || option.model === args.model)
    && (typeof args.channelGroup !== 'string' || option.channelGroup === args.channelGroup))
  const option = requested.find(candidate => /^gpt-image/i.test(candidate.model)) ?? requested[0]
  if (!option) throw new Error('所选绘画连接、模型或 TokenNest 图片分组不可用；请先调用 list_image_connections。')
  const count = args.count === undefined ? 1 : args.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 4) throw new Error('count must be between 1 and 4')
  const size = args.size === undefined ? '1024x1024' : args.size
  if (size !== '1024x1024' && size !== '1536x1024' && size !== '1024x1536') throw new Error('Invalid image size')

  const result = await generateStudioImage({
    connectionSlug: option.connectionSlug, model: option.model, channelGroup: option.channelGroup,
    prompt, count, size, transparentBackground: args.transparentBackground === true,
  })
  const bytes = result.images.map(image => {
    const data = Buffer.from(image.imageBase64, 'base64')
    if (data.length > 30_000_000 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error('Image provider returned invalid PNG data')
    }
    return data
  })
  const directory = join(getSessionPath(workspaceRoot, sessionId), 'generated-images')
  await mkdir(directory, { recursive: true })
  const images = await Promise.all(bytes.map(async (data, index) => {
    const path = join(directory, `${Date.now()}-${index}-${randomUUID()}.png`)
    await writeFile(path, data, { flag: 'wx' })
    return { path, bytes: data.length }
  }))
  return { images, count: images.length, connectionSlug: option.connectionSlug, model: option.model,
    ...(option.channelGroup ? { channelGroup: option.channelGroup } : {}) }
}

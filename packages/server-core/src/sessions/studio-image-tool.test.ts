import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as config from '@craft-agent/shared/config'
import * as credentials from '@craft-agent/shared/credentials'
import * as auth from '@craft-agent/shared/auth'
import { runStudioImageToolAction } from './studio-image-tool'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; mock.restore() })

describe('agent image generation', () => {
  it('explains when no drawing connection is configured', async () => {
    spyOn(config, 'getLlmConnections').mockReturnValue([])
    const listing = await runStudioImageToolAction('/tmp/workspace', 'session-1', { action: 'list_image_connections' })
    expect(listing).toMatchObject({ available: false, options: [] })
    await expect(runStudioImageToolAction('/tmp/workspace', 'session-1', {
      action: 'generate_image', prompt: '一只鸟',
    })).rejects.toThrow('请先配置')
  })

  it('does not expose an image model without its API key', async () => {
    spyOn(config, 'getLlmConnections').mockReturnValue([{
      slug: 'image-no-key', name: 'Image', providerType: 'pi', authType: 'api_key',
      piAuthProvider: 'openai', models: ['gpt-image-1'], createdAt: 1,
    } as ReturnType<typeof config.getLlmConnections>[number]])
    spyOn(credentials, 'getCredentialManager').mockReturnValue({ getLlmApiKey: async () => null } as never)
    expect(await runStudioImageToolAction('/tmp/workspace', 'session-1', { action: 'list_image_connections' }))
      .toMatchObject({ available: false, options: [] })
  })

  it('generates a PNG with a configured GPT Image connection and saves it in the session', async () => {
    const connection = {
      slug: 'openai-image', name: 'OpenAI Image', providerType: 'pi', authType: 'api_key',
      piAuthProvider: 'openai', models: ['gpt-image-1'], createdAt: 1,
    } as ReturnType<typeof config.getLlmConnections>[number]
    spyOn(config, 'getLlmConnections').mockReturnValue([connection])
    spyOn(config, 'getLlmConnection').mockReturnValue(connection)
    spyOn(credentials, 'getCredentialManager').mockReturnValue({ getLlmApiKey: async () => 'secret' } as never)
    let requestedModel = ''
    globalThis.fetch = mock(async (_url, init) => {
      requestedModel = JSON.parse(String(init?.body)).model
      return Response.json({ data: [{ b64_json: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString('base64') }] })
    }) as unknown as typeof fetch
    const root = mkdtempSync(join(tmpdir(), 'studio-image-tool-'))
    try {
      expect(await runStudioImageToolAction(root, 'session-1', { action: 'list_image_connections' }))
        .toMatchObject({ available: true, options: [{ connectionSlug: 'openai-image', model: 'gpt-image-1' }] })
      const result = await runStudioImageToolAction(root, 'session-1', {
        action: 'generate_image', prompt: '一只鸟',
      }) as { images: Array<{ path: string }> }
      expect(requestedModel).toBe('gpt-image-1')
      expect(result.images).toHaveLength(1)
      expect(existsSync(result.images[0].path)).toBe(true)
      expect(result.images[0].path).toContain('generated-images')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses an authenticated TokenNest image group', async () => {
    const connection = {
      slug: 'tokennest', name: 'TokenNest', providerType: 'pi', authType: 'oauth',
      oauthProvider: 'tokennest', channelGroups: [{ id: 'drawing', name: '图片', models: ['gpt-image-1'] }],
      createdAt: 1,
    } as ReturnType<typeof config.getLlmConnections>[number]
    spyOn(config, 'getLlmConnections').mockReturnValue([connection])
    spyOn(config, 'getLlmConnection').mockReturnValue(connection)
    spyOn(credentials, 'getCredentialManager').mockReturnValue({} as never)
    spyOn(auth, 'getValidTokenNestCredentials').mockResolvedValue({ accessToken: 'oauth-token' } as never)
    let group = ''
    globalThis.fetch = mock(async (_url, init) => {
      group = new Headers(init?.headers).get('X-TokenNest-Group') ?? ''
      return Response.json({ data: [{ b64_json: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString('base64') }] })
    }) as unknown as typeof fetch
    const root = mkdtempSync(join(tmpdir(), 'studio-tokennest-image-tool-'))
    try {
      const result = await runStudioImageToolAction(root, 'session-1', {
        action: 'generate_image', prompt: '山水画', connectionSlug: 'tokennest', channelGroup: 'drawing',
      }) as { images: Array<{ path: string }> }
      expect(group).toBe('drawing')
      expect(existsSync(result.images[0].path)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

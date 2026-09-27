import { describe, expect, test } from 'bun:test'
import { getGitCodeUpdateFeed } from './gitcode-release'

const repository = 'Goldgom/craft-agents-oss'
const assetUrl = (name: string) =>
  `https://gitcode.com/${repository}/releases/download/26.9.25/${name}`

function mockRelease(tag_name: string, assets: Array<{ name: string; browser_download_url: string }>) {
  return async () => Response.json({ tag_name, prerelease: false, assets })
}

describe('GitCode update feed', () => {
  test('does not downgrade or require update files for an older release', async () => {
    const feed = await getGitCodeUpdateFeed('26.9.27', repository, mockRelease('26.9.20', []))
    expect(feed).toEqual({ version: '26.9.20', feedUrl: null })
  })

  test('uses only a complete release from the configured repository', async () => {
    const assets = [
      { name: 'latest.yml', browser_download_url: assetUrl('latest.yml') },
      { name: 'TokenBird-x64.exe', browser_download_url: assetUrl('TokenBird-x64.exe') },
    ]
    const feed = await getGitCodeUpdateFeed('26.9.27', repository, mockRelease('26.9.25', assets))
    expect(feed.feedUrl).toBe(assetUrl(''))
  })

  test('rejects incomplete releases and foreign download URLs', async () => {
    const manifest = { name: 'latest.yml', browser_download_url: assetUrl('latest.yml') }
    await expect(getGitCodeUpdateFeed('26.9.27', repository, mockRelease('26.9.25', [manifest])))
      .rejects.toThrow('must contain latest.yml and TokenBird-x64.exe')
    await expect(getGitCodeUpdateFeed('26.9.27', repository, mockRelease('26.9.25', [
      manifest,
      { name: 'TokenBird-x64.exe', browser_download_url: 'https://example.com/TokenBird-x64.exe' },
    ]))).rejects.toThrow('Unexpected GitCode release asset URL')
  })
})
